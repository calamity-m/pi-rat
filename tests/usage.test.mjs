import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "..");
const compiledSubscriptionPath = join(projectRoot, ".usage-subscriptions.test.mjs");
const compiledTokensPath = join(projectRoot, ".usage-tokens.test.mjs");
const compiledSystemPromptPath = join(projectRoot, ".usage-system-prompt.test.mjs");
let helpers;

before(async () => {
  await compileUsageModule("extensions/usage/subscriptions/index.ts", compiledSubscriptionPath);
  await compileUsageModule("extensions/usage/tokens/index.ts", compiledTokensPath);
  await compileUsageModule("extensions/usage/system-prompt.ts", compiledSystemPromptPath);

  const subscriptions = await import(
    `${pathToFileURL(compiledSubscriptionPath).href}?t=${Date.now()}`
  );
  const tokens = await import(`${pathToFileURL(compiledTokensPath).href}?t=${Date.now()}`);
  const systemPrompt = await import(
    `${pathToFileURL(compiledSystemPromptPath).href}?t=${Date.now()}`
  );
  helpers = { ...subscriptions, ...tokens, ...systemPrompt };
});

after(async () => {
  await rm(compiledSubscriptionPath, { force: true });
  await rm(compiledTokensPath, { force: true });
  await rm(compiledSystemPromptPath, { force: true });
});

async function compileUsageModule(sourcePath, outputPath) {
  const source = await readFile(join(projectRoot, sourcePath), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  await writeFile(outputPath, compiled, "utf8");
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

function assistantEntry({ provider = "openai-codex", model = "gpt-5", timestamp, usage }) {
  return JSON.stringify({
    type: "message",
    id: "entry",
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      provider,
      model,
      timestamp,
      usage: {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 165,
        cost: { total: 0.123 },
        ...usage,
      },
    },
  });
}

describe("usage helpers", () => {
  test("matches only openai-codex provider names", () => {
    assert.equal(helpers.isOpenAICodexProvider("openai-codex"), true);
    assert.equal(helpers.isOpenAICodexProvider("openai-codex-1"), true);
    assert.equal(helpers.isOpenAICodexProvider("openai-codex-beta"), false);
    assert.equal(helpers.isOpenAICodexProvider("openai"), false);
    assert.equal(helpers.isOpenAICodexProvider(undefined), false);
  });

  test("extracts ChatGPT metadata from an OAuth JWT payload", () => {
    const token = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
        chatgpt_plan_type: "plus",
      },
      "https://api.openai.com/profile": { email: "user@example.com" },
    });

    assert.deepEqual(helpers.getTokenMetadata(token), {
      accountId: "acct_123",
      planType: "plus",
      email: "user@example.com",
    });
  });

  test("malformed JWT metadata returns no fields", () => {
    assert.deepEqual(helpers.getTokenMetadata("not-a-jwt"), {
      accountId: undefined,
      planType: undefined,
      email: undefined,
    });
  });

  test("detects 5-hour and weekly windows regardless of primary order", () => {
    const snapshot = helpers.parseUsageSnapshot(
      {
        plan_type: "pro",
        email: "body@example.com",
        rate_limit: {
          primary_window: {
            used_percent: 12.3,
            limit_window_seconds: helpers.WEEK_SECONDS - 60,
            reset_at: 2_000_000_000,
          },
          secondary_window: {
            used_percent: 45.6,
            limit_window_seconds: helpers.FIVE_HOUR_SECONDS + 30,
            reset_at: 2_000_010_000,
          },
        },
      },
      1_700_000_000_000,
    );

    assert.equal(snapshot.planType, "pro");
    assert.equal(snapshot.email, "body@example.com");
    assert.equal(snapshot.weekly.usedPercent, 12.3);
    assert.equal(snapshot.fiveHour.usedPercent, 45.6);
    assert.equal(snapshot.fetchedAt, 1_700_000_000_000);
  });

  test("formats missing fields clearly", () => {
    const lines = helpers.buildUsageDetails({ fetchedAt: 1_700_000_000_000 }, "openai-codex");

    assert.match(lines.join("\n"), /plan: unknown/);
    assert.match(lines.join("\n"), /email: unknown/);
    assert.match(lines.join("\n"), /5-hour: unknown/);
    assert.match(lines.join("\n"), /weekly: unknown/);
    assert.match(lines.join("\n"), /endpoint: https:\/\/chatgpt\.com\/backend-api\/wham\/usage/);
  });

  test("aggregates token usage by provider and model", () => {
    const now = Date.parse("2026-07-05T00:00:00Z");
    const report = helpers.aggregateTokenUsage(
      [
        {
          sessionId: "one.jsonl",
          content: [
            assistantEntry({
              timestamp: now - 1_000,
              usage: { input: 20, output: 30, totalTokens: 50 },
            }),
            assistantEntry({
              provider: "anthropic",
              model: "claude",
              timestamp: now - 2_000,
              usage: { input: 40, output: 60, totalTokens: 100 },
            }),
          ].join("\n"),
        },
        {
          sessionId: "two.jsonl",
          content: assistantEntry({
            timestamp: now - 3_000,
            usage: { input: 5, output: 10, totalTokens: 15 },
          }),
        },
      ],
      now,
    );

    assert.equal(report.sessionFiles, 2);
    assert.equal(report.providerModels.length, 2);
    const codex = report.providerModels.find(
      (entry) => entry.providerModel === "openai-codex/gpt-5",
    );
    assert.equal(codex.allTime.input, 25);
    assert.equal(codex.allTime.output, 40);
    assert.equal(codex.allTime.total, 65);
    assert.equal(codex.allTime.responses, 2);
    assert.equal(codex.allTime.sessions, 2);
  });

  test("separates 30d token usage from all-time totals", () => {
    const now = Date.parse("2026-07-05T00:00:00Z");
    const old = now - 31 * 24 * 60 * 60 * 1000;
    const recent = now - 29 * 24 * 60 * 60 * 1000;
    const report = helpers.aggregateTokenUsage(
      [
        {
          sessionId: "one.jsonl",
          content: [
            assistantEntry({
              timestamp: old,
              usage: { input: 1000, output: 1, totalTokens: 1001 },
            }),
            assistantEntry({ timestamp: recent, usage: { input: 10, output: 2, totalTokens: 12 } }),
          ].join("\n"),
        },
      ],
      now,
    );

    const providerModel = report.providerModels[0];
    assert.equal(providerModel.allTime.total, 1013);
    assert.equal(providerModel.last30d.total, 12);
    assert.equal(providerModel.last30d.responses, 1);
  });

  test("skips malformed and non-assistant session entries", () => {
    const now = Date.parse("2026-07-05T00:00:00Z");
    const report = helpers.aggregateTokenUsage(
      [
        {
          sessionId: "one.jsonl",
          content: [
            "not json",
            JSON.stringify({ type: "session", id: "header" }),
            JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
            JSON.stringify({
              type: "message",
              message: { role: "assistant", provider: "x", model: "y" },
            }),
            assistantEntry({ timestamp: now, usage: { input: 1, output: 2, totalTokens: 3 } }),
          ].join("\n"),
        },
      ],
      now,
    );

    assert.equal(report.providerModels.length, 1);
    assert.equal(report.providerModels[0].allTime.total, 3);
  });

  test("builds system prompt usage sections with token counts", () => {
    const sections = helpers.buildSystemPromptSections("compiled prompt", {
      cwd: projectRoot,
      selectedTools: ["read", "write", "hidden"],
      toolSnippets: {
        read: "Read a file",
        write: "Write a file",
      },
      skills: [
        {
          name: "visible-skill",
          description: "Visible to the model",
          filePath: "/skills/visible/SKILL.md",
          baseDir: "/skills/visible",
          sourceInfo: { scope: "user", source: "test" },
          disableModelInvocation: false,
        },
        {
          name: "user-only-skill",
          description: "Hidden from the model",
          filePath: "/skills/hidden/SKILL.md",
          baseDir: "/skills/hidden",
          sourceInfo: { scope: "user", source: "test" },
          disableModelInvocation: true,
        },
      ],
      contextFiles: [{ path: "/repo/AGENTS.md", content: "Project instructions" }],
    });

    const compiled = sections.find((section) => section.id === "compiled");
    assert.equal(compiled.label, "Compiled System Prompt");
    assert.match(compiled.description, /estimated tokens/);
    assert.match(compiled.lines.join("\n"), /compiled prompt/);

    const tools = sections.find((section) => section.id === "tools").lines.join("\n");
    assert.match(tools, /read — \d+ tokens/);
    assert.match(tools, /write — \d+ tokens/);
    assert.doesNotMatch(tools, /hidden/);

    const skills = sections.find((section) => section.id === "skills").lines.join("\n");
    assert.match(skills, /visible-skill — \d+ tokens/);
    assert.doesNotMatch(skills, /user-only-skill/);

    const contextFiles = sections
      .find((section) => section.id === "context-files")
      .lines.join("\n");
    assert.match(contextFiles, /\/repo\/AGENTS\.md — \d+ tokens/);
  });

  test("formats token usage with 30d and all-time lines", () => {
    const report = helpers.aggregateTokenUsage(
      [
        {
          sessionId: "one.jsonl",
          content: assistantEntry({
            timestamp: 1_700_000_000_000,
            usage: { input: 1000, output: 2000, totalTokens: 3000 },
          }),
        },
      ],
      1_700_000_000_000,
    );

    const lines = helpers.buildTokenUsageDetails(report, "/sessions").join("\n");
    assert.match(lines, /Token usage by provider\/model/);
    assert.match(lines, /window: last 30d \+ all-time/);
    assert.match(lines, /source: \/sessions/);
    assert.match(lines, /openai-codex\/gpt-5/);
    assert.match(lines, /30d:/);
    assert.match(lines, /all:/);
  });
});
