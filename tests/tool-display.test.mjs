import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "..");
const compiledPath = join(projectRoot, ".tool-display.test.mjs");
let helpers;
let toolDisplay;

before(async () => {
  const source = await readFile(join(projectRoot, "extensions/tool-display.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  await writeFile(compiledPath, compiled, "utf8");
  const imported = await import(`${pathToFileURL(compiledPath).href}?t=${Date.now()}`);
  helpers = imported.__toolDisplayForTest;
  toolDisplay = imported.default;
});

after(async () => {
  await rm(compiledPath, { force: true });
});

const plainTheme = {
  fg(_name, text) {
    return text;
  },
  bold(text) {
    return text;
  },
};

function renderLines(component, width = 120) {
  return component.render(width).map((line) => line.trimEnd());
}

function registeredEditTool() {
  const tools = [];
  toolDisplay({
    on() {},
    registerTool(tool) {
      tools.push(tool);
    },
  });
  return tools.find((tool) => tool.name === "edit");
}

describe("tool-display registration", () => {
  test("registers all built-in tool overrides when loaded", async () => {
    const imported = await import(`${pathToFileURL(compiledPath).href}?registration=${Date.now()}`);
    const registeredTools = [];
    imported.default({
      on() {},
      registerTool(tool) {
        registeredTools.push(tool.name);
      },
    });

    assert.deepEqual(registeredTools.sort(), [
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  });
});

describe("tool-display edit diff formatting", () => {
  test("parses display diff lines", () => {
    assert.deepEqual(helpers.parseDisplayDiffLine("+314 const next = true;"), {
      kind: "+",
      lineNumber: "314",
      content: "const next = true;",
    });
    assert.deepEqual(helpers.parseDisplayDiffLine("-  7 old"), {
      kind: "-",
      lineNumber: "  7",
      content: "old",
    });
    assert.deepEqual(helpers.parseDisplayDiffLine("  42 context"), {
      kind: " ",
      lineNumber: " 42",
      content: "context",
    });
  });

  test("counts additions and deletions and aligns table borders", () => {
    const diff = ["  9 before", "-10 old", "+10 new", "+11 extra", " 12 after"].join("\n");
    const stats = helpers.diffLineStats(diff);
    assert.deepEqual(stats, { additions: 2, deletions: 1, lineNumberWidth: 2 });

    const headerLines = helpers
      .formatDiffTableHeader(plainTheme, stats.lineNumberWidth)
      .split("\n");
    const rows = helpers.formatDiffTableLines(diff, plainTheme, stats.lineNumberWidth, true);
    const headerSep = headerLines[0].indexOf("│");
    const borderSep = headerLines[1].indexOf("┼");
    assert.equal(headerSep, borderSep);
    for (const row of rows) assert.equal(row.indexOf("│"), headerSep);
  });

  test("replaces tabs in diff content", () => {
    const [row] = helpers.formatDiffTableLines("+1 a\tb", plainTheme, 1, true);
    assert.match(row, /a   b/);
  });

  test("expanded diff formatting shows more context than collapsed formatting", () => {
    const diff = Array.from(
      { length: 20 },
      (_, index) => ` ${String(index + 1).padStart(2)} line ${index + 1}`,
    );
    diff[10] = "-11 old";
    diff[11] = "+11 new";
    const text = diff.join("\n");
    const expanded = helpers.formatDiffTableLines(text, plainTheme, 2, true);
    const collapsed = helpers.formatDiffTableLines(text, plainTheme, 2, false);

    assert.equal(expanded.length, 20);
    assert.ok(collapsed.length < expanded.length / 2);
    assert.ok(collapsed.some((line) => line.includes("...")));
  });

  test("collapsed edit diff does not add incorrect edge ellipses", () => {
    assert.notEqual(
      helpers.compactDiffLines(["-1 old", "+1 new", " 2 next", " 3 tail"])[0],
      "  ...",
    );

    const bottom = helpers.compactDiffLines([" 1 head", " 2 prev", "-3 old", "+3 new"]);
    assert.notEqual(bottom.at(-1), "  ...");
  });

  test("collapsed edit diff merges nearby hunks without middle ellipses", () => {
    const collapsed = helpers.compactDiffLines([
      " 1 head",
      " 2 context",
      " 3 before",
      "-4 old",
      "+4 new",
      " 5 between",
      "-6 old",
      "+6 new",
      " 7 after",
      " 8 tail",
    ]);
    const middle = collapsed.slice(1, -1);

    assert.deepEqual(
      middle.filter((line) => line === "  ..."),
      [],
    );
  });

  test("collapsed edit diff separates far hunks with a middle ellipsis", () => {
    const collapsed = helpers.compactDiffLines([
      " 1 head",
      " 2 before first",
      "-3 old",
      "+3 new",
      " 4 after first",
      " 5 gap",
      " 6 gap",
      " 7 gap",
      " 8 gap",
      " 9 gap",
      " 10 before second",
      "-11 old",
      "+11 new",
      " 12 after second",
      " 13 tail",
    ]);
    const middle = collapsed.slice(1, -1);

    assert.ok(middle.some((line) => line === "  ..."));
  });

  test("registered edit renderer rails both collapsed and expanded output", () => {
    const edit = registeredEditTool();
    assert.ok(edit?.renderResult);

    const diff = Array.from(
      { length: 18 },
      (_, index) => ` ${String(index + 1).padStart(2)} line ${index + 1}`,
    );
    diff[8] = "-9 old";
    diff[9] = "+9 new";
    const result = {
      content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
      details: { diff: diff.join("\n") },
    };
    const context = { isError: false, cwd: projectRoot, args: { path: "demo.txt", edits: [] } };

    const collapsed = renderLines(
      edit.renderResult(result, { expanded: false }, plainTheme, context),
    );
    const expanded = renderLines(
      edit.renderResult(result, { expanded: true }, plainTheme, context),
    );

    assert.equal(collapsed[0], "▌");
    assert.equal(collapsed.at(-1), "▌");
    assert.equal(expanded[0], "▌");
    assert.equal(expanded.at(-1), "▌");
    assert.ok(collapsed.length < expanded.length);
  });
});

describe("tool-display rails", () => {
  function fakeChild(lines) {
    return {
      invalidated: false,
      render(width) {
        this.lastWidth = width;
        return lines;
      },
      invalidate() {
        this.invalidated = true;
      },
    };
  }

  test("call rail has no top or bottom caps", () => {
    const child = fakeChild(["call"]);
    const rail = new helpers.ToolRail(child, "▌", false);
    assert.deepEqual(rail.render(20), ["▌ call"]);
    assert.equal(child.lastWidth, 18);
  });

  test("result rail has top and bottom caps", () => {
    const child = fakeChild(["line 1", "line 2"]);
    const rail = new helpers.ToolRail(child, "▌", true);
    assert.deepEqual(rail.render(20), ["▌", "▌ line 1", "▌ line 2", "▌"]);
    assert.equal(child.lastWidth, 18);
  });

  test("rail exposes wrapped child so expanded built-in renderers can reuse their own state", () => {
    const child = fakeChild(["x"]);
    const rail = new helpers.ToolRail(child, "▌", true);
    assert.equal(rail.child, child);
  });

  test("rail forwards invalidation and handles zero width", () => {
    const child = fakeChild(["x"]);
    const rail = new helpers.ToolRail(child, "▌", true);
    assert.deepEqual(rail.render(0), []);
    rail.invalidate();
    assert.equal(child.invalidated, true);
  });
});
