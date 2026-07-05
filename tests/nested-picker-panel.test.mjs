import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { visibleWidth } from "@earendil-works/pi-tui";

const projectRoot = resolve(import.meta.dirname, "..");
const compiledPath = join(projectRoot, ".nested-picker-panel.test.mjs");
let NestedPickerPanel;

before(async () => {
  const source = await readFile(join(projectRoot, "extensions/lib/nested-picker-panel.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  await writeFile(compiledPath, compiled, "utf8");
  const imported = await import(`${pathToFileURL(compiledPath).href}?t=${Date.now()}`);
  NestedPickerPanel = imported.NestedPickerPanel;
});

after(async () => {
  await rm(compiledPath, { force: true });
});

const theme = {
  fg(_color, text) {
    return text;
  },
};

const colorCodes = {
  accent: "\x1b[35m",
  borderMuted: "\x1b[2m",
  dim: "\x1b[90m",
  warning: "\x1b[33m",
};
const reset = "\x1b[0m";
const coloredTheme = {
  fg(color, text) {
    return `${colorCodes[color] ?? "\x1b[37m"}${text}${reset}`;
  },
};

const keybindings = {
  matches(data, id) {
    const keys = {
      "tui.select.up": ["up", "\x1b[A"],
      "tui.select.down": ["down", "\x1b[B"],
      "tui.select.confirm": ["enter", "\r"],
      "tui.select.cancel": ["esc", "\x1b"],
    };
    return keys[id]?.includes(data) ?? false;
  },
};

const rows = [
  {
    id: "start",
    label: "start",
    description: "first branch",
    children: [
      {
        id: "middle",
        label: "middle",
        description: "second branch",
        children: [
          { id: "end", label: "end", description: "terminal row" },
          { id: "other-end", label: "other end" },
        ],
      },
      { id: "side", label: "side leaf" },
    ],
  },
  { id: "tools", label: "tools", description: "top-level searchable branch", children: [] },
];

function panel(overrides = {}) {
  return new NestedPickerPanel({
    title: "picker",
    rows,
    theme,
    keybindings,
    requestRender() {},
    renderContent: ({ row, path, width }) =>
      `content ${path.map((item) => item.label).join(" -> ")} ${row.label} ${width}`,
    onCancel() {},
    ...overrides,
  });
}

function renderLines(component, width = 80) {
  return component.render(width).map((line) => line.trimEnd());
}

function visibleText(component, width = 80) {
  return renderLines(component, width).join("\n");
}

describe("NestedPickerPanel navigation and rendering", () => {
  test("descends through branch rows and updates the breadcrumb", () => {
    const picker = panel();

    assert.match(visibleText(picker), /Path: root/);
    assert.match(visibleText(picker), /start/);

    picker.handleInput("enter");
    assert.match(visibleText(picker), /Path: start/);
    assert.match(visibleText(picker), /middle/);

    picker.handleInput("enter");
    assert.match(visibleText(picker), /Path: start -> middle/);
    assert.match(visibleText(picker), /end/);
  });

  test("leaf Enter invokes onLeafEnter and switches into rendered content", () => {
    let enteredPath;
    const picker = panel({
      onLeafEnter(row, path) {
        enteredPath = { row: row.label, path: path.map((item) => item.label) };
      },
    });

    picker.handleInput("enter");
    picker.handleInput("enter");
    picker.handleInput("enter");

    assert.deepEqual(enteredPath, { row: "end", path: ["start", "middle", "end"] });
    assert.match(visibleText(picker), /content start -> middle -> end end/);
  });

  test("delegates unreserved input to an active leaf component", () => {
    const received = [];
    const leafComponent = {
      render() {
        return ["interactive leaf"];
      },
      handleInput(data) {
        received.push(data);
      },
      invalidate() {},
    };
    const picker = panel({ renderContent: () => leafComponent });

    picker.handleInput("enter");
    picker.handleInput("enter");
    picker.handleInput("enter");
    picker.handleInput("x");

    assert.deepEqual(received, ["x"]);
  });

  test("Left and Backspace navigate to parent levels and out of content", () => {
    const picker = panel();

    picker.handleInput("enter");
    picker.handleInput("enter");
    assert.match(visibleText(picker), /Path: start -> middle/);

    picker.handleInput("enter");
    assert.match(visibleText(picker), /Path: start -> middle -> end/);

    picker.handleInput("\x1b[D");
    assert.match(visibleText(picker), /Path: start -> middle/);

    picker.handleInput("\x1b[D");
    assert.match(visibleText(picker), /Path: start/);

    picker.handleInput("\x7f");
    assert.match(visibleText(picker), /Path: root/);
  });

  test("Esc returns to root first and cancels only from root", () => {
    let cancels = 0;
    const picker = panel({ onCancel: () => cancels++ });

    picker.handleInput("enter");
    picker.handleInput("enter");
    picker.handleInput("esc");

    assert.equal(cancels, 0);
    assert.match(visibleText(picker), /Path: root/);

    picker.handleInput("esc");
    assert.equal(cancels, 1);
  });

  test("optional search filters rows and resets the selection safely", () => {
    const picker = panel({ enableSearch: true });

    for (const char of "tools") picker.handleInput(char);
    const text = visibleText(picker);

    assert.match(text, /tools/);
    assert.doesNotMatch(text, /first branch/);
    picker.handleInput("enter");
    assert.match(visibleText(picker), /content tools tools/);
  });

  test("search input keeps editor keys for cursor movement and deletion", () => {
    const picker = panel({
      enableSearch: true,
      rows: [
        { id: "ac", label: "ac" },
        { id: "abc", label: "abc" },
      ],
    });

    for (const char of "abc") picker.handleInput(char);
    picker.handleInput("\x1b[D");
    picker.handleInput("\x7f");

    const text = visibleText(picker);
    assert.match(text, /ac/);
    assert.doesNotMatch(text, /abc/);
  });

  test("string leaf content scrolls inside the nested panel", () => {
    const picker = panel({
      visibleRows: 3,
      rows: [{ id: "leaf", label: "leaf" }],
      renderContent: () => Array.from({ length: 8 }, (_, index) => `line ${index}`),
    });

    picker.handleInput("enter");
    assert.match(visibleText(picker), /line 0/);
    assert.doesNotMatch(visibleText(picker), /line 4/);

    picker.handleInput("down");
    const text = visibleText(picker);
    assert.doesNotMatch(text, /line 0/);
    assert.match(text, /line 1/);
    assert.match(text, /line 3/);
  });

  test("leafVisibleRows can make leaf content taller than picker rows", () => {
    const picker = panel({
      visibleRows: 2,
      leafVisibleRows: 5,
      rows: [{ id: "leaf", label: "leaf" }],
      renderContent: () => Array.from({ length: 8 }, (_, index) => `line ${index}`),
    });

    picker.handleInput("enter");
    const text = visibleText(picker);
    assert.match(text, /line 0/);
    assert.match(text, /line 4/);
    assert.doesNotMatch(text, /line 5/);
  });

  test("long string leaf lines wrap before scrolling", () => {
    const picker = panel({
      visibleRows: 2,
      rows: [{ id: "leaf", label: "leaf" }],
      renderContent: () => "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
    });

    picker.handleInput("enter");
    const before = visibleText(picker, 24);
    assert.match(before, /alpha bravo/);
    assert.doesNotMatch(before, /india juliet/);

    picker.handleInput("down");
    picker.handleInput("down");
    const after = visibleText(picker, 24);
    assert.doesNotMatch(after, /alpha bravo/);
    assert.match(after, /india juliet/);
  });

  test("renders the title inside prompt-colored borders", () => {
    const picker = panel({ theme: coloredTheme });
    const lines = picker.render(24);

    assert.ok(lines[0].startsWith(colorCodes.borderMuted), lines[0]);
    assert.match(lines[0], /picker/);
    assert.equal(visibleWidth(lines[0]), 24);
    assert.ok(lines.at(-1).startsWith(colorCodes.borderMuted), lines.at(-1));
    assert.equal(visibleWidth(lines.at(-1)), 24);
  });

  test("uses a caller-supplied border color for title and borders", () => {
    const thinkingColor = "\x1b[34m";
    const picker = panel({
      borderColor: (text) => `${thinkingColor}${text}${reset}`,
      theme: coloredTheme,
    });
    const lines = picker.render(24);

    assert.ok(lines[0].startsWith(thinkingColor), lines[0]);
    assert.match(lines[0], /picker/);
    assert.ok(lines.at(-1).startsWith(thinkingColor), lines.at(-1));
    assert.equal(visibleWidth(lines[0]), 24);
  });

  test("falls back to a plain prompt-colored top border when the title is too wide", () => {
    const picker = panel({ theme: coloredTheme });
    const lines = picker.render(9);

    assert.ok(lines[0].startsWith(colorCodes.borderMuted), lines[0]);
    assert.doesNotMatch(lines[0], /picker/);
    assert.equal(visibleWidth(lines[0]), 9);
  });

  test("clips long row labels and content to the requested width", () => {
    const longPicker = panel({
      rows: [{ id: "long", label: "a".repeat(100) }],
      renderContent: () => "b".repeat(100),
    });

    for (const line of longPicker.render(20)) assert.ok(visibleWidth(line) <= 20, line);
    longPicker.handleInput("enter");
    for (const line of longPicker.render(20)) assert.ok(visibleWidth(line) <= 20, line);
  });
});
