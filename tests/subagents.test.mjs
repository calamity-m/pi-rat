import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "..");
const sourceDir = join(projectRoot, "extensions/subagents");
const compiledDir = join(projectRoot, ".subagents-test");
let helpers;

const files = [
  "types.ts",
  "store.ts",
  "model-resolution.ts",
  "settings.ts",
  "preset-agents.ts",
  "prompt.ts",
];

before(async () => {
  await mkdir(compiledDir, { recursive: true });
  for (const file of files) {
    const source = await readFile(join(sourceDir, file), "utf8");
    const compiled = ts
      .transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          verbatimModuleSyntax: true,
        },
      })
      .outputText.replaceAll('.ts"', '.mjs"');
    await writeFile(join(compiledDir, file.replace(/\.ts$/, ".mjs")), compiled, "utf8");
  }
  const [model, settings, prompt, store] = await Promise.all([
    import(`${pathToFileURL(join(compiledDir, "model-resolution.mjs")).href}?t=${Date.now()}`),
    import(`${pathToFileURL(join(compiledDir, "settings.mjs")).href}?t=${Date.now()}`),
    import(`${pathToFileURL(join(compiledDir, "prompt.mjs")).href}?t=${Date.now()}`),
    import(`${pathToFileURL(join(compiledDir, "store.mjs")).href}?t=${Date.now()}`),
  ]);
  helpers = { ...model, ...settings, ...prompt, ...store };
});

after(async () => {
  await rm(compiledDir, { recursive: true, force: true });
});

function makeRegistry(
  models,
  available = new Set(models.map((model) => `${model.provider}/${model.id}`)),
) {
  return {
    find(provider, modelId) {
      return models.find((model) => model.provider === provider && model.id === modelId);
    },
    hasConfiguredAuth(model) {
      return available.has(`${model.provider}/${model.id}`);
    },
  };
}

describe("subagent model helpers", () => {
  test("parseCanonicalModelId accepts provider/model and rejects missing pieces", () => {
    assert.deepEqual(helpers.parseCanonicalModelId("openai/gpt-5"), {
      provider: "openai",
      modelId: "gpt-5",
    });
    assert.throws(() => helpers.parseCanonicalModelId("openai"), /Invalid canonical model id/);
    assert.throws(() => helpers.parseCanonicalModelId("/gpt-5"), /Invalid canonical model id/);
    assert.throws(() => helpers.parseCanonicalModelId("openai/"), /Invalid canonical model id/);
  });

  test("normalizeThinkingLevel accepts supported levels and rejects unsupported strings", () => {
    assert.equal(helpers.normalizeThinkingLevel("minimal"), "minimal");
    assert.equal(helpers.normalizeThinkingLevel(undefined), undefined);
    assert.throws(() => helpers.normalizeThinkingLevel("huge"), /Invalid thinkingLevel/);
  });

  test("resolver falls back for missing tier but keeps raw model strict", () => {
    const parent = { provider: "anthropic", id: "claude" };
    const registry = makeRegistry([parent]);
    const ctx = { model: parent, modelRegistry: registry };

    const fallback = helpers.resolveSubagentModelCore(
      { task: "x", tier: "fast" },
      { tiers: {} },
      ctx,
      "low",
    );
    assert.equal(fallback.modelId, "anthropic/claude");
    assert.match(fallback.warning, /No subagent model configured/);

    assert.throws(
      () =>
        helpers.resolveSubagentModelCore(
          { task: "x", model: "missing/model" },
          { tiers: {} },
          ctx,
          "low",
        ),
      /Unknown model/,
    );
  });

  test("resolver falls back when tier model is unavailable", () => {
    const parent = { provider: "anthropic", id: "claude" };
    const fast = { provider: "openai", id: "fast" };
    const ctx = {
      model: parent,
      modelRegistry: makeRegistry([parent, fast], new Set(["anthropic/claude"])),
    };

    const resolved = helpers.resolveSubagentModelCore(
      { task: "x", tier: "fast" },
      { tiers: { fast: { model: "openai/fast" } } },
      ctx,
      "medium",
    );
    assert.equal(resolved.modelId, "anthropic/claude");
    assert.match(resolved.source, /fallback/);
  });
});

describe("subagent TUI guardrails", () => {
  test("dashboard does not open nested Pi modal prompts", async () => {
    const source = await readFile(join(sourceDir, "ui.ts"), "utf8");
    assert.doesNotMatch(source, /ctx\.ui\.(?:select|confirm|input)\s*\(/);
  });
});

describe("subagent settings helpers", () => {
  test("parseSubagentSettings reads valid tiers and warns on invalid shapes", () => {
    const result = helpers.parseSubagentSettings({
      piRat: {
        subagents: {
          tiers: {
            fast: { model: "openai/fast", thinkingLevel: "minimal" },
            high: { model: "bad" },
          },
        },
      },
    });
    assert.deepEqual(result.settings.tiers.fast, {
      model: "openai/fast",
      thinkingLevel: "minimal",
    });
    assert.equal(result.settings.tiers.high, undefined);
    assert.match(result.warnings.join("\n"), /Invalid canonical model id/);
  });

  test("mergeSubagentSettings preserves unrelated root keys", () => {
    const merged = helpers.mergeSubagentSettings(
      { permissions: { rules: [] }, theme: "kanagawa" },
      { tiers: { fast: { model: "openai/fast" } } },
    );
    assert.deepEqual(merged.permissions, { rules: [] });
    assert.equal(merged.theme, "kanagawa");
    assert.equal(merged.piRat.subagents.tiers.fast.model, "openai/fast");
  });
});

describe("subagent prompt and preset helpers", () => {
  test("applyPresetAgent preserves explicit caller overrides", () => {
    const presets = new Map([
      [
        "explorer",
        {
          name: "explorer",
          tier: "fast",
          tools: "read-only",
          outputFormat: "bullets",
          body: "preset role",
          sourcePath: "x",
        },
      ],
    ]);
    const merged = helpers.applyPresetAgent(
      { agent: "explorer", task: "do it", tier: "high", tools: "coding", role: "caller role" },
      presets,
    );
    assert.equal(merged.tier, "high");
    assert.equal(merged.tools, "coding");
    assert.match(merged.role, /preset role/);
    assert.match(merged.role, /caller role/);
  });

  test("buildSubagentPrompt includes role/context/files/task", () => {
    const prompt = helpers.buildSubagentPrompt(
      { task: "Inspect", role: "Reviewer", context: "Repo context", files: ["README.md"] },
      ["### README.md\n```\nhello\n```"],
    );
    assert.match(prompt, /Role:\nReviewer/);
    assert.match(prompt, /Context:\nRepo context/);
    assert.match(prompt, /Preloaded files:/);
    assert.match(prompt, /Task:\nInspect/);
  });

  test("formatCancellationResult includes notes and partial output", () => {
    const text = helpers.formatCancellationResult(
      { id: "alpha-aa", cancelNotes: "stop", status: "aborted", startedAt: Date.now() },
      "partial",
    );
    assert.match(text, /stop/);
    assert.match(text, /partial/);
  });
});
