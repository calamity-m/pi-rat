import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "../..");
const compiledPath = join(import.meta.dirname, ".context-viewer.test.mjs");
let helpers;

before(async () => {
  let source = await readFile(join(import.meta.dirname, "index.ts"), "utf8");
  source = source
    .replace(
      /import \{[\s\S]*?\} from "\.\.\/lib\/nested-picker-panel\.ts";\n/,
      "const NestedPickerPanel = class {};\n",
    )
    .replace(
      /import \{ currentThinkingBorderColor \} from "\.\.\/lib\/thinking-border\.ts";\n/,
      "const currentThinkingBorderColor = () => (text) => text;\n",
    );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  await writeFile(compiledPath, compiled, "utf8");
  helpers = await import(`${pathToFileURL(compiledPath).href}?t=${Date.now()}`);
});

after(async () => {
  await rm(compiledPath, { force: true });
});

function messageEntry(id, message) {
  return { type: "message", id, parentId: null, timestamp: "2026-07-06T00:00:00.000Z", message };
}

const promptOptions = {
  cwd: "/repo",
  selectedTools: ["read", "bash"],
  toolSnippets: { read: "Read file contents", bash: "Execute shell commands" },
  promptGuidelines: ["Use read before editing."],
  contextFiles: [{ path: "AGENTS.md", content: "Keep changes focused." }],
  skills: [
    {
      name: "plan-t1",
      description: "Fast plans",
      filePath: "/skills/plan-t1/SKILL.md",
      baseDir: "/skills/plan-t1",
      sourceInfo: { path: "/skills", source: "user", scope: "user", origin: "top-level" },
      disableModelInvocation: false,
    },
  ],
};

const tools = [
  {
    name: "read",
    description: "Read file contents",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    promptGuidelines: ["Use read to inspect files."],
    sourceInfo: {
      path: "<builtin:read>",
      source: "builtin",
      scope: "temporary",
      origin: "top-level",
    },
  },
  {
    name: "custom_tool",
    description: "Custom helper",
    parameters: { type: "object" },
    promptGuidelines: [],
    sourceInfo: { path: "/ext.ts", source: "pi-rat", scope: "project", origin: "package" },
  },
];

describe("context-viewer helpers", () => {
  test("estimates and formats approximate tokens", () => {
    assert.equal(helpers.estimateTextTokens(""), 0);
    assert.equal(helpers.estimateTextTokens("abcd"), 1);
    assert.equal(helpers.estimateTextTokens("abcde"), 2);
    assert.equal(helpers.formatApproxTokens(1234), "~1,234 tokens");
  });

  test("renders an 8x11 dotgrid with markers and reserve cells", () => {
    const grid = helpers.renderContextDotgrid({
      usedPercent: 20,
      markerPercent: 5,
      outputReservePercent: 10,
    });

    assert.equal(grid.length, 8);
    assert.ok(grid.every((line) => line.split(" ").length === 11));
    assert.equal(grid[0].split(" ")[0], "◍");
    assert.match(grid.join(" "), /⚙/);
    assert.match(grid.at(-1), /○/);
  });

  test("dotgrid does not hide high usage behind reserve cells", () => {
    const grid = helpers.renderContextDotgrid({ usedPercent: 95, outputReservePercent: 10 });
    const cells = grid.join(" ").split(" ");

    assert.equal(cells.filter((cell) => cell === "○").length, 4);
    assert.equal(cells.filter((cell) => cell === "●" || cell === "◍").length, 84);
  });

  test("groups messages, tools, context files, and skills into sections", () => {
    const breakdown = helpers.buildContextBreakdown({
      branchEntries: [
        messageEntry("u1", { role: "user", content: "Please inspect context." }),
        messageEntry("a1", {
          role: "assistant",
          content: [
            { type: "text", text: "I will read a file." },
            { type: "toolCall", id: "call:read", name: "read", arguments: { path: "README.md" } },
          ],
        }),
        messageEntry("t1", {
          role: "toolResult",
          toolCallId: "call:read",
          toolName: "read",
          content: [{ type: "text", text: "README contents" }],
          isError: false,
        }),
        { type: "model_change", id: "m1", parentId: "t1", provider: "openai", modelId: "gpt" },
      ],
      systemPrompt: "System prompt text",
      promptOptions,
      allTools: tools,
      activeTools: ["read"],
      contextUsage: { tokens: 250, contextWindow: 1000, percent: 25 },
      model: { provider: "openai", id: "gpt", contextWindow: 1000, maxTokens: 100 },
    });

    assert.equal(breakdown.summary.contextTokens, 250);
    assert.equal(breakdown.summary.dotgrid.length, 8);

    const messages = breakdown.sections.find((section) => section.id === "messages");
    assert.ok(messages);
    assert.ok(messages.children.some((section) => section.id === "messages-assistant"));
    assert.ok(messages.children.some((section) => section.id === "messages-toolResult"));
    const assistant = messages.children.find((section) => section.id === "messages-assistant");
    assert.ok(assistant.children.some((section) => section.id === "assistant-text-0"));
    const toolResults = messages.children.find((section) => section.id === "messages-toolResult");
    assert.match(toolResults.children[0].description, /call:read/);

    const toolsSection = breakdown.sections.find((section) => section.id === "tools");
    assert.ok(toolsSection.children.some((section) => section.id === "tools-builtin"));
    assert.ok(toolsSection.children.some((section) => section.id === "tools-pi-rat"));

    assert.ok(
      breakdown.sections.find((section) => section.id === "context-files").children.length === 1,
    );
    assert.ok(breakdown.sections.find((section) => section.id === "skills").children.length === 1);
    assert.ok(
      breakdown.sections.find((section) => section.id === "other-entries").children.length === 1,
    );
  });

  test("empty active tools means no tools are marked active", () => {
    const breakdown = helpers.buildContextBreakdown({
      branchEntries: [],
      systemPrompt: "System prompt text",
      promptOptions,
      allTools: tools,
      activeTools: [],
      contextUsage: { tokens: 0, contextWindow: 1000, percent: 0 },
      model: { provider: "openai", id: "gpt", contextWindow: 1000, maxTokens: 100 },
    });

    const toolsSection = breakdown.sections.find((section) => section.id === "tools");
    assert.match(toolsSection.description, /0 active/);
    const builtin = toolsSection.children.find((section) => section.id === "tools-builtin");
    assert.match(builtin.description, /0 active/);
  });
});
