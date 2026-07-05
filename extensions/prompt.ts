import { readFileSync } from "node:fs";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type EditorComponent,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { SearchPanel, type SearchPanelBorderColor } from "./lib/search-panel.ts";
import { currentThinkingBorderColor } from "./lib/thinking-border.ts";

/** Prompt template loaded from Pi's discovered prompt slash commands. */
interface PromptTemplate {
  /** Slash command name without the leading slash. */
  name: string;
  /** User-facing description from Pi metadata or prompt frontmatter. */
  description: string;
  /** Optional one-line argument hint from simple prompt frontmatter. */
  argumentHint: string;
  /** Source markdown file path for diagnostics. */
  path: string;
  /** Prompt markdown body without supported frontmatter. */
  body: string;
}

/** Parsed subset of prompt markdown frontmatter supported by this command. */
interface ParsedFrontmatter {
  /** Simple one-line string key/value data. */
  data: Record<string, string>;
  /** Markdown body after the frontmatter block, or original text if no valid block exists. */
  body: string;
  /** Warning to surface when a frontmatter-looking block is malformed. */
  warning?: string;
}

/** Result of trying to load a prompt command from disk. */
type PromptLoadResult = { prompt: PromptTemplate } | { warning: string };

/** Editable placeholder field in a visual prompt-fill session. */
interface FillField {
  /** Placeholder tokens that should share the same value. */
  tokens: string[];
  /** Label shown in the fill UI. */
  label: string;
  /** Current replacement value. */
  value: string;
}

/** Lines of prompt context shown above the active placeholder. */
const FILL_CONTEXT_LINES_BEFORE = 5;

/** Lines of prompt context shown below the active placeholder. */
const FILL_CONTEXT_LINES_AFTER = 8;

/** Maximum number of prompt template matches to render at once in the picker. */
const VISIBLE_PROMPT_RESULTS = 10;

/** Regex matching every placeholder token this command supports. */
const PLACEHOLDER_PATTERN = /\$ARGUMENTS|\$@|\$[1-9][0-9]*|\$\{@:[0-9]+(?::[0-9]+)?\}/g;

/**
 * Parse the documented simple frontmatter subset used by prompt templates.
 *
 * Supported frontmatter is a leading `---` block containing `key: value` string
 * lines. This intentionally avoids pretending to be a full YAML parser.
 */
function parseFrontmatter(text: string): ParsedFrontmatter {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return { data: {}, body: text };

  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return {
      data: {},
      body: text,
      warning: "frontmatter starts with --- but has no closing ---",
    };
  }

  const data: Record<string, string> = {};
  const frontmatter = normalized.slice(4, end);
  for (const [index, line] of frontmatter.split("\n").entries()) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      return {
        data: {},
        body: text,
        warning: `unsupported frontmatter line ${index + 1}: ${line}`,
      };
    }
    data[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }

  const bodyStart = normalized.startsWith("\n", end + 4) ? end + 5 : end + 4;
  return { data, body: normalized.slice(bodyStart) };
}

/** Load a discovered prompt command from its source markdown file. */
function readPrompt(command: SlashCommandInfo): PromptLoadResult {
  try {
    const text = readFileSync(command.sourceInfo.path, "utf8");
    const parsed = parseFrontmatter(text);
    if (parsed.warning) return { warning: `/${command.name}: ${parsed.warning}` };
    return {
      prompt: {
        name: command.name,
        description: command.description ?? parsed.data.description ?? "",
        argumentHint: parsed.data["argument-hint"] ?? "",
        path: command.sourceInfo.path,
        body: parsed.body.trim(),
      },
    };
  } catch (error) {
    return {
      warning: `/${command.name}: unable to read ${command.sourceInfo.path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Split shell-like prompt arguments, supporting quotes and backslash escapes. */
function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (current) args.push(current);
  return args;
}

/**
 * Return the raw argument text following the first whitespace-delimited token.
 *
 * Used to recover the verbatim argument string after the prompt name on direct
 * invocation, preserving original quoting, backslashes, and surrounding
 * whitespace that `splitArgs`/`join` would otherwise normalize away.
 */
function rawArgsAfterFirstToken(input: string): string {
  const match = input.match(/^\s*\S+\s?([\s\S]*)$/);
  return match ? match[1] : "";
}

/** Expand supported prompt placeholders with raw and positional arguments. */
function expandPrompt(body: string, rawArgs: string): string {
  const positional = splitArgs(rawArgs);
  return body
    .replace(/\$ARGUMENTS/g, rawArgs)
    .replace(/\$@/g, rawArgs)
    .replace(
      /\$\{@:([0-9]+)(?::([0-9]+))?\}/g,
      (_match, startText: string, lengthText: string | undefined) => {
        const start = Math.max(0, Number(startText) - 1);
        const length = lengthText === undefined ? undefined : Math.max(0, Number(lengthText));
        return positional.slice(start, length === undefined ? undefined : start + length).join(" ");
      },
    )
    .replace(/\$([1-9][0-9]*)/g, (_match, indexText: string) => {
      return positional[Number(indexText) - 1] ?? "";
    });
}

/** Return a stable display label for a prompt picker item. */
function promptLabel(prompt: PromptTemplate): string {
  const hint = prompt.argumentHint ? ` ${prompt.argumentHint}` : "";
  const description = prompt.description ? ` — ${prompt.description}` : "";
  return `/${prompt.name}${hint}${description}`;
}

/** Return all prompt templates matching the current picker query. */
function searchPrompts(prompts: readonly PromptTemplate[], query: string): PromptTemplate[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return normalizedQuery
    ? prompts.filter((prompt) => promptSearchText(prompt).includes(normalizedQuery))
    : [...prompts];
}

/** Return the combined searchable text for one prompt template. */
function promptSearchText(prompt: PromptTemplate): string {
  return [prompt.name, prompt.argumentHint, prompt.description].join(" ").toLocaleLowerCase();
}

/** Detect fields the visual filler should ask the user to populate. */
function detectFillFields(body: string, initialArgs: string): FillField[] {
  const fields = new Map<string, FillField>();
  const positional = splitArgs(initialArgs);
  const hasRawArguments = /\$(?:ARGUMENTS|@)(?![A-Za-z0-9_])/.test(body);

  if (hasRawArguments) {
    const rawField = { tokens: ["$ARGUMENTS", "$@"], label: "$ARGUMENTS", value: initialArgs };
    fields.set("$ARGUMENTS", rawField);
    fields.set("$@", rawField);
  }

  for (const match of body.matchAll(/\$([1-9][0-9]*)/g)) {
    const token = match[0];
    const index = Number(match[1]);
    if (!fields.has(token)) {
      fields.set(token, { tokens: [token], label: token, value: positional[index - 1] ?? "" });
    }
  }

  for (const match of body.matchAll(/\$\{@:([0-9]+)(?::([0-9]+))?\}/g)) {
    const token = match[0];
    const start = Math.max(0, Number(match[1]) - 1);
    const length = match[2] === undefined ? undefined : Math.max(0, Number(match[2]));
    if (!fields.has(token)) {
      fields.set(token, {
        tokens: [token],
        label: token,
        value: positional.slice(start, length === undefined ? undefined : start + length).join(" "),
      });
    }
  }

  return [...new Set(fields.values())];
}

/** Expand placeholders from values supplied by the visual filler. */
function expandVisualPrompt(body: string, fields: FillField[]): string {
  let text = body;
  const replacements = fields.flatMap((field) => {
    return field.tokens.map((token) => ({ token, value: field.value }));
  });
  for (const replacement of replacements.sort((a, b) => b.token.length - a.token.length)) {
    text = text.replaceAll(replacement.token, replacement.value);
  }
  return text;
}

/** Inline TUI editor that lets the user fill prompt placeholders in context. */
class PromptFillEditor implements EditorComponent, Focusable {
  /** Whether Pi has focused this editor component. */
  focused = false;
  /** Called when any field edit changes the expanded text. */
  onChange?: (text: string) => void;
  /** Currently edited field index. */
  private active = 0;
  /** TUI instance used to request redraws after edits. */
  private readonly tui: TUI;
  /** Prompt metadata shown in the fill UI. */
  private readonly prompt: PromptTemplate;
  /** Source prompt body containing placeholders. */
  private readonly body: string;
  /** Mutable fields filled by the user. */
  private readonly fields: FillField[];
  /** Active Pi theme helper. */
  private readonly theme: ExtensionCommandContext["ui"]["theme"];
  /** Current thinking-level border color helper. */
  private readonly panelBorderColor: SearchPanelBorderColor;
  /** Completion callback for submit or cancel. */
  private readonly done: (result: string | undefined) => void;

  /** Create an inline prompt placeholder editor. */
  constructor(
    tui: TUI,
    prompt: PromptTemplate,
    body: string,
    fields: FillField[],
    theme: ExtensionCommandContext["ui"]["theme"],
    borderColor: SearchPanelBorderColor,
    done: (result: string | undefined) => void,
  ) {
    this.tui = tui;
    this.prompt = prompt;
    this.body = body;
    this.fields = fields;
    this.theme = theme;
    this.panelBorderColor = borderColor;
    this.done = done;
  }

  /** Return the prompt body with current field values substituted. */
  getText(): string {
    return expandVisualPrompt(this.body, this.fields);
  }

  /** Ignore external whole-buffer edits; this component edits structured fields only. */
  setText(_text: string): void {}

  /** No cached layout to invalidate. */
  invalidate(): void {}

  /** Handle keyboard input for field editing, navigation, submit, and cancel. */
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.active = Math.max(0, this.active - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.enter)) {
      this.advance();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      const field = this.fields[this.active];
      field.value = [...field.value].slice(0, -1).join("");
      this.onChange?.(this.getText());
      this.tui.requestRender();
      return;
    }

    const pasteStart = "\u001b[200~";
    const pasteEnd = "\u001b[201~";
    if (data.startsWith(pasteStart) && data.endsWith(pasteEnd)) {
      const paste = data.slice(pasteStart.length, -pasteEnd.length);
      this.fields[this.active].value += paste;
      this.onChange?.(this.getText());
      this.tui.requestRender();
      return;
    }

    if (data.length > 0 && !data.startsWith("\x1b")) {
      this.fields[this.active].value += data;
      this.onChange?.(this.getText());
      this.tui.requestRender();
    }
  }

  /** Render the active field plus nearby prompt context. */
  render(width: number): string[] {
    const pane = this.renderBodyPane();
    const border = this.panelBorderColor("─".repeat(Math.max(0, width)));
    const lines = [
      border,
      truncateToWidth(
        this.theme.fg(
          "accent",
          `Filling /${this.prompt.name} (${this.active + 1}/${this.fields.length}): ${this.fields[this.active].label}`,
        ),
        width,
      ),
      truncateToWidth(
        this.theme.fg(
          "dim",
          "Type to fill highlighted variable • tab/enter next • shift+tab previous • esc cancel",
        ),
        width,
      ),
      "",
    ];
    if (pane.start > 0)
      lines.push(
        truncateToWidth(this.theme.fg("dim", `… ${pane.start} lines above hidden`), width),
      );
    for (const line of pane.lines) lines.push(...wrapTextWithAnsi(line, width));
    if (pane.end < pane.total) {
      lines.push(
        truncateToWidth(
          this.theme.fg("dim", `… ${pane.total - pane.end} lines below hidden`),
          width,
        ),
      );
    }
    lines.push(border);
    return lines;
  }

  /** Move to the next field or submit the expanded prompt when all fields are filled. */
  private advance(): void {
    if (this.active < this.fields.length - 1) {
      this.active++;
      this.tui.requestRender();
      return;
    }
    const finalText = this.getText();
    this.done(finalText);
  }

  /** Render only nearby lines around the active placeholder to keep large prompts readable. */
  private renderBodyPane(): { lines: string[]; start: number; end: number; total: number } {
    const sourceLines = this.body.split("\n");
    const activeField = this.fields[this.active];
    const activeLine = Math.max(
      0,
      // Match whole placeholder tokens so `$1` does not select a line whose only
      // placeholder is `$10`.
      sourceLines.findIndex((line) =>
        [...line.matchAll(PLACEHOLDER_PATTERN)].some((match) =>
          activeField.tokens.includes(match[0]),
        ),
      ),
    );
    const start = Math.max(0, activeLine - FILL_CONTEXT_LINES_BEFORE);
    const end = Math.min(sourceLines.length, activeLine + FILL_CONTEXT_LINES_AFTER + 1);
    return {
      lines: sourceLines.slice(start, end).map((line) => this.renderBodyLine(line)),
      start,
      end,
      total: sourceLines.length,
    };
  }

  /** Render one prompt body line, highlighting placeholder values. */
  private renderBodyLine(line: string): string {
    const fieldsByToken = new Map(
      this.fields.flatMap((field) => field.tokens.map((token) => [token, field] as const)),
    );
    const activeField = this.fields[this.active];
    let rendered = "";
    let index = 0;

    for (const match of line.matchAll(PLACEHOLDER_PATTERN)) {
      const token = match[0];
      const start = match.index ?? 0;
      rendered += this.theme.fg("dim", line.slice(index, start));

      const field = fieldsByToken.get(token);
      if (!field) {
        rendered += this.theme.fg("dim", token);
      } else if (field !== activeField) {
        rendered += this.theme.fg("muted", field.value || `⟦${field.label}⟧`);
      } else {
        const text = field.value || `⟦${field.label}⟧`;
        rendered += this.theme.bg(
          "selectedBg",
          this.theme.fg("accent", `${text}${this.focused ? CURSOR_MARKER : ""} `),
        );
      }

      index = start + token.length;
    }

    rendered += this.theme.fg("dim", line.slice(index));
    return rendered;
  }
}

/** Sentinel marking a UI that accepts but silently ignores custom editor components. */
const CUSTOM_EDITOR_UNSUPPORTED = Symbol("custom-editor-unsupported");

/** Fill a prompt either through the inline visual TUI or the generic editor fallback. */
async function fillPromptVisually(
  ctx: ExtensionCommandContext,
  prompt: PromptTemplate,
  initialArgs: string,
): Promise<string | undefined> {
  const fields = detectFillFields(prompt.body, initialArgs);
  if (fields.length === 0) return prompt.body;

  const previousEditor = ctx.ui.getEditorComponent();
  const visual = await new Promise<string | undefined | typeof CUSTOM_EDITOR_UNSUPPORTED>(
    (resolve) => {
      const factory = (tui: TUI) =>
        new PromptFillEditor(
          tui,
          prompt,
          prompt.body,
          fields,
          ctx.ui.theme,
          currentThinkingBorderColor(ctx, ctx.ui.theme),
          resolve,
        );
      ctx.ui.setEditorComponent(factory);
      // RPC and print UIs accept setEditorComponent() but never mount the component
      // (so the promise would hang); they report the no-op by not retaining the factory.
      if (ctx.ui.getEditorComponent() !== factory) resolve(CUSTOM_EDITOR_UNSUPPORTED);
    },
  );
  ctx.ui.setEditorComponent(previousEditor);

  if (visual !== CUSTOM_EDITOR_UNSUPPORTED) return visual;

  const label = prompt.argumentHint
    ? `Arguments for /${prompt.name}: ${prompt.argumentHint}`
    : `Arguments for /${prompt.name}`;
  const multilineArgs = await ctx.ui.editor(label, initialArgs);
  return multilineArgs === undefined ? undefined : expandPrompt(prompt.body, multilineArgs);
}

/** Load prompt templates and collect visible diagnostics for skipped templates. */
function loadPrompts(commands: SlashCommandInfo[]): {
  prompts: PromptTemplate[];
  warnings: string[];
} {
  const prompts: PromptTemplate[] = [];
  const warnings: string[] = [];
  const names = new Map<string, string>();

  for (const command of commands.filter((item) => item.source === "prompt")) {
    const loaded = readPrompt(command);
    if ("warning" in loaded) {
      warnings.push(loaded.warning);
      continue;
    }

    const previousPath = names.get(loaded.prompt.name);
    if (previousPath) {
      warnings.push(
        `/${loaded.prompt.name}: duplicate prompt name from ${loaded.prompt.path}; already loaded from ${previousPath}`,
      );
      continue;
    }

    names.set(loaded.prompt.name, loaded.prompt.path);
    prompts.push(loaded.prompt);
  }

  return { prompts, warnings };
}

/** Resolve the prompt selected or requested by the user. */
async function choosePrompt(
  ctx: ExtensionCommandContext,
  prompts: PromptTemplate[],
  requestedName: string | undefined,
): Promise<PromptTemplate | undefined> {
  if (requestedName) {
    const prompt = prompts.find(
      (item) => item.name === requestedName || `/${item.name}` === requestedName,
    );
    if (!prompt) {
      ctx.ui.notify(`Unknown prompt template: ${requestedName}`, "warning");
    }
    return prompt;
  }

  return await ctx.ui.custom<PromptTemplate | undefined>((tui, theme, keybindings, done) => {
    return new SearchPanel<PromptTemplate>({
      title: "prompt",
      rows: prompts,
      visibleRows: VISIBLE_PROMPT_RESULTS,
      showRowsWhenQueryEmpty: true,
      emptyQueryText: "Type to filter prompt templates…",
      noResultsText: "No matching prompt templates",
      footerText: "↑↓ navigate/scroll • enter select • esc cancel",
      theme,
      keybindings,
      requestRender: () => tui.requestRender(),
      borderColor: currentThinkingBorderColor(ctx, theme),
      filterRows: searchPrompts,
      renderRow: (prompt) => promptLabel(prompt),
      onSelect: done,
      onCancel: () => done(undefined),
    });
  });
}

/** Register `/prompt`, a visual prompt-template picker and filler for discovered templates. */
export function registerPrompt(pi: ExtensionAPI): void {
  pi.registerCommand("prompt", {
    description: "Pick a prompt template, fill variables, and populate the editor",
    getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
      const items = pi
        .getCommands()
        .filter((command) => command.source === "prompt" && command.name.startsWith(prefix))
        .map((command) => {
          return { value: command.name, label: command.name, description: command.description };
        });
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/prompt needs an interactive UI to populate the editor", "warning");
        return;
      }

      const { prompts, warnings } = loadPrompts(pi.getCommands());
      for (const warning of warnings) ctx.ui.notify(`[prompt] ${warning}`, "warning");
      if (prompts.length === 0) {
        ctx.ui.notify("No prompt templates available", "info");
        return;
      }

      const [requestedName] = splitArgs(args);
      const prompt = await choosePrompt(ctx, prompts, requestedName);
      if (!prompt) return;

      // Direct invocation still opens the fill UI so users can review/edit substitutions before use.
      // Keep the raw substring after the name so $ARGUMENTS/$@ preserve original quoting and whitespace.
      const initialArgs =
        prompt.name === requestedName || `/${prompt.name}` === requestedName
          ? rawArgsAfterFirstToken(args)
          : args;
      const filled = await fillPromptVisually(ctx, prompt, initialArgs);
      if (filled === undefined) return;

      ctx.ui.setEditorText(filled);
      ctx.ui.notify(`Filled editor from /${prompt.name}`, "info");
    },
  });
}

/** Standalone Pi extension entrypoint. */
export default function promptExtension(pi: ExtensionAPI): void {
  registerPrompt(pi);
}

/** Expose pure helpers for focused unit tests. */
export const __promptForTest = {
  parseFrontmatter,
  splitArgs,
  rawArgsAfterFirstToken,
  expandPrompt,
  promptLabel,
  searchPrompts,
  detectFillFields,
  expandVisualPrompt,
  loadPrompts,
  PromptFillEditor,
} satisfies Record<string, unknown>;
