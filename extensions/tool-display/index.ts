import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashToolDetails,
  type ExtensionAPI,
  type FindToolDetails,
  type FindToolInput,
  type GrepToolDetails,
  type GrepToolInput,
  type LsToolDetails,
  type LsToolInput,
  type ReadToolDetails,
  type ReadToolInput,
  type ToolDefinition,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

type TextishContent = { type: "text"; text: string };

type BuiltInToolDefinitions = {
  read: ReturnType<typeof createReadToolDefinition>;
  bash: ReturnType<typeof createBashToolDefinition>;
  edit: ReturnType<typeof createEditToolDefinition>;
  write: ReturnType<typeof createWriteToolDefinition>;
  grep: ReturnType<typeof createGrepToolDefinition>;
  find: ReturnType<typeof createFindToolDefinition>;
  ls: ReturnType<typeof createLsToolDefinition>;
};

/** Built-in tool definitions keyed by cwd so execution still uses the active project root. */
const toolDefinitionCache = new Map<string, BuiltInToolDefinitions>();

/** Left rail used for every tool result body. */
const TOOL_OUTPUT_RAIL = "▌";

/** Context lines around edits in collapsed mode. Expanded mode shows all available diff lines. */
const COMPACT_EDIT_CONTEXT_LINES = 1;

/** Pi-rat tool-output renderer. Always active when this extension is loaded. */
export default function toolDisplay(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("tool-display", "tools styled");
  });

  registerRead(pi);
  registerBash(pi);
  registerSearchTools(pi);
  registerMutationTools(pi);
}

function getBuiltInTools(cwd: string): BuiltInToolDefinitions {
  const cached = toolDefinitionCache.get(cwd);
  if (cached) return cached;

  const definitions = {
    read: createReadToolDefinition(cwd),
    bash: createBashToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    grep: createGrepToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
  };
  toolDefinitionCache.set(cwd, definitions);
  return definitions;
}

function registerRead(pi: ExtensionAPI): void {
  const base = getBuiltInTools(process.cwd()).read;
  pi.registerTool({
    ...base,
    renderCall(args, theme, _context) {
      const path = stylePath(args.path, theme);
      const range = formatReadRange(args);
      return withToolCallRail(
        new Text(`${theme.fg("toolTitle", theme.bold("read"))} ${path}${range}`, 0, 0),
        theme,
      );
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderResult(result, options, theme, context) {
      const builtIn = maybeRenderBuiltIn("read", result, options, theme, context);
      if (builtIn) return builtIn;

      const text = textOutput(result);
      const details = result.details as ReadToolDetails | undefined;
      const lines = countContentLines(text);
      const metric = context.isError
        ? theme.fg("error", "↳ read failed")
        : theme.fg("muted", `↳ loaded ${lines} lines`);
      return withToolOutputRail(quietText([metric, truncationNote(details, theme)]), theme);
    },
  });
}

function registerBash(pi: ExtensionAPI): void {
  const base = getBuiltInTools(process.cwd()).bash;
  pi.registerTool({
    ...base,
    renderCall(args, theme, context) {
      const command = args.command ? truncate(args.command.replace(/\s+/g, " "), 160) : "…";
      const timeout = args.timeout ? theme.fg("muted", ` timeout=${args.timeout}s`) : "";
      const running =
        context.executionStarted && context.isPartial ? theme.fg("warning", " running") : "";
      return withToolCallRail(
        new Text(
          `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", command)}${timeout}${running}`,
          0,
          0,
        ),
        theme,
      );
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderResult(result, options, theme, context) {
      const builtIn = maybeRenderBuiltIn("bash", result, options, theme, context);
      if (builtIn) return builtIn;

      const text = stripToolFooter(textOutput(result));
      const details = result.details as BashToolDetails | undefined;
      const lines = countContentLines(text);
      const status = context.isError ? bashFailureLabel(text) : "exit 0";
      const metric = [
        theme.fg(context.isError ? "error" : "muted", `↳ ${status}`),
        theme.fg("muted", `${lines} lines`),
        truncationNote(details, theme),
        details?.fullOutputPath
          ? theme.fg("warning", `full: ${details.fullOutputPath}`)
          : undefined,
      ].filter(Boolean);
      const signalLines = context.isError ? previewLines(text, 3, "signal-tail", theme) : [];
      return withToolOutputRail(
        quietText([metric.join(theme.fg("dim", " · ")), ...signalLines]),
        theme,
      );
    },
  });
}

function registerSearchTools(pi: ExtensionAPI): void {
  registerListLikeTool<GrepToolInput, GrepToolDetails | undefined>(pi, "grep", {
    base: getBuiltInTools(process.cwd()).grep,
    current: (cwd) => getBuiltInTools(cwd).grep,
    call: (args, theme) => {
      const path = stylePath(args.path ?? ".", theme);
      const flags = [
        args.glob,
        args.ignoreCase ? "ignore-case" : undefined,
        args.literal ? "literal" : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      return `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${args.pattern ?? "…"}/`)} ${theme.fg("dim", "in")} ${path}${flags ? theme.fg("muted", ` (${flags})`) : ""}`;
    },
    noun: "matches",
  });

  registerListLikeTool<FindToolInput, FindToolDetails | undefined>(pi, "find", {
    base: getBuiltInTools(process.cwd()).find,
    current: (cwd) => getBuiltInTools(cwd).find,
    call: (args, theme) =>
      `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", args.pattern ?? "…")} ${theme.fg("dim", "in")} ${stylePath(args.path ?? ".", theme)}`,
    noun: "results",
  });

  registerListLikeTool<LsToolInput, LsToolDetails | undefined>(pi, "ls", {
    base: getBuiltInTools(process.cwd()).ls,
    current: (cwd) => getBuiltInTools(cwd).ls,
    call: (args, theme) =>
      `${theme.fg("toolTitle", theme.bold("ls"))} ${stylePath(args.path ?? ".", theme)}${args.limit ? theme.fg("muted", ` limit=${args.limit}`) : ""}`,
    noun: "entries",
  });
}

function registerListLikeTool<TParams, TDetails>(
  pi: ExtensionAPI,
  toolName: "grep" | "find" | "ls",
  options: {
    base: ToolDefinition<any, TDetails>;
    current: (cwd: string) => ToolDefinition<any, TDetails>;
    call: (
      args: TParams,
      theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1],
    ) => string;
    noun: string;
  },
): void {
  pi.registerTool({
    ...options.base,
    renderCall(args, theme) {
      return withToolCallRail(new Text(options.call(args as TParams, theme), 0, 0), theme);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return options.current(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderResult(result, resultOptions, theme, context) {
      const builtIn = maybeRenderBuiltIn(toolName, result, resultOptions, theme, context);
      if (builtIn) return builtIn;

      const text = textOutput(result);
      const details = result.details as { truncation?: unknown } | undefined;
      const count = countContentLines(text);
      const metric = context.isError
        ? theme.fg("error", `↳ ${toolName} failed`)
        : theme.fg("muted", `↳ ${count} ${options.noun} returned`);
      return withToolOutputRail(quietText([metric, truncationNote(details, theme)]), theme);
    },
  });
}

function registerMutationTools(pi: ExtensionAPI): void {
  const editBase = getBuiltInTools(process.cwd()).edit;
  pi.registerTool({
    ...editBase,
    renderShell: "default",
    renderCall(args, theme) {
      const blockCount = Array.isArray(args.edits) ? args.edits.length : 0;
      return withToolCallRail(
        new Text(
          `${theme.fg("toolTitle", theme.bold("edit"))} ${stylePath(args.path, theme)} ${theme.fg("muted", `(${blockCount} block${blockCount === 1 ? "" : "s"})`)}`,
          0,
          0,
        ),
        theme,
      );
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderResult(result, options, theme, context) {
      return withToolOutputRail(renderBorderedEditResult(result, options, theme, context), theme);
    },
  });

  const writeBase = getBuiltInTools(process.cwd()).write;
  pi.registerTool({
    ...writeBase,
    renderCall(args, theme) {
      const lines = countContentLines(args.content ?? "");
      return withToolCallRail(
        new Text(
          `${theme.fg("toolTitle", theme.bold("write"))} ${stylePath(args.path, theme)} ${theme.fg("muted", `${lines} lines`)}`,
          0,
          0,
        ),
        theme,
      );
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderResult(result, options, theme, context) {
      const builtIn = maybeRenderBuiltIn("write", result, options, theme, context);
      if (builtIn) return builtIn;

      const args = context.args as WriteToolInput;
      const lines = countContentLines(args.content ?? "");
      const metric = context.isError
        ? theme.fg("error", "↳ write failed")
        : theme.fg("muted", `↳ wrote ${lines} lines`);
      const signalLines = context.isError
        ? previewLines(textOutput(result), 3, "signal-tail", theme)
        : [];
      return withToolOutputRail(quietText([metric, ...signalLines]), theme);
    },
  });
}

type ToolRenderComponent = ReturnType<NonNullable<ToolDefinition["renderResult"]>>;

class ToolRail implements Component {
  constructor(
    readonly child: Component,
    private readonly rail: string,
    private readonly caps: boolean,
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const childWidth = Math.max(0, width - 2);
    const childLines = this.child.render(childWidth).map((line) => `${this.rail} ${line}`);
    return this.caps ? [this.rail, ...childLines, this.rail] : childLines;
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

function withToolCallRail(
  component: Component,
  theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1],
): Component {
  return new ToolRail(component, theme.fg("accent", TOOL_OUTPUT_RAIL), false);
}

function withToolOutputRail(
  component: ToolRenderComponent,
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
): ToolRenderComponent {
  return new ToolRail(component, theme.fg("accent", TOOL_OUTPUT_RAIL), true);
}

function maybeRenderBuiltIn(
  toolName: keyof BuiltInToolDefinitions,
  result: Parameters<NonNullable<ToolDefinition["renderResult"]>>[0],
  options: Parameters<NonNullable<ToolDefinition["renderResult"]>>[1],
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
  context: Parameters<NonNullable<ToolDefinition["renderResult"]>>[3],
): ToolRenderComponent | undefined {
  if (options.expanded) {
    return withToolOutputRail(
      renderBuiltInResult(toolName, result, options, theme, context),
      theme,
    );
  }
  return undefined;
}

function renderBuiltInResult(
  toolName: keyof BuiltInToolDefinitions,
  result: Parameters<NonNullable<ToolDefinition["renderResult"]>>[0],
  options: Parameters<NonNullable<ToolDefinition["renderResult"]>>[1],
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
  context: Parameters<NonNullable<ToolDefinition["renderResult"]>>[3],
): ToolRenderComponent {
  const render = getBuiltInTools(context.cwd)[toolName].renderResult;
  if (!render) return renderRawResult(result, theme);

  const unwrappedContext = {
    ...context,
    lastComponent:
      context.lastComponent instanceof ToolRail
        ? context.lastComponent.child
        : context.lastComponent,
  };
  return render(result as never, options, theme, unwrappedContext as never);
}

function renderRawResult(
  result: Parameters<NonNullable<ToolDefinition["renderResult"]>>[0],
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
): Text {
  const text = textOutput(result);
  return new Text(text ? `\n${styleOutputLines(text, theme).join("\n")}` : "", 0, 0);
}

function renderBorderedEditResult(
  result: Parameters<NonNullable<ToolDefinition["renderResult"]>>[0],
  options: Parameters<NonNullable<ToolDefinition["renderResult"]>>[1],
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
  context: Parameters<NonNullable<ToolDefinition["renderResult"]>>[3],
): Text {
  if (context.isError) {
    return quietText([
      theme.fg("error", "↳ edit failed"),
      ...previewLines(textOutput(result), 3, "signal-tail", theme),
    ]);
  }

  const details = result.details as { diff?: string } | undefined;
  const diff = details?.diff;
  if (!diff) return quietText([theme.fg("muted", "↳ edit complete")]);

  const stats = diffLineStats(diff);
  const lines = [
    `${theme.fg("muted", "↳ diff ")}${theme.fg("success", `+${stats.additions}`)} ${theme.fg("error", `-${stats.deletions}`)}${theme.fg("muted", " · unified")}`,
    formatDiffTableHeader(theme, stats.lineNumberWidth),
    ...formatDiffTableLines(diff, theme, stats.lineNumberWidth, options.expanded),
  ];
  return new Text(lines.join("\n"), 0, 0);
}

function textOutput(result: Parameters<NonNullable<ToolDefinition["renderResult"]>>[0]): string {
  return result.content
    .map((content) => {
      if (content.type === "text") return (content as TextishContent).text;
      if (content.type === "image") return "[image attachment]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function quietText(lines: readonly (string | undefined)[]): Text {
  return new Text(
    lines.filter((line): line is string => Boolean(line && line.trim().length > 0)).join("\n"),
    0,
    0,
  );
}

function diffLineStats(diff: string): {
  additions: number;
  deletions: number;
  lineNumberWidth: number;
} {
  let additions = 0;
  let deletions = 0;
  let lineNumberWidth = 1;
  for (const line of splitContentLines(diff)) {
    const parsed = parseDisplayDiffLine(line);
    if (!parsed) continue;
    if (parsed.kind === "+") additions++;
    if (parsed.kind === "-") deletions++;
    lineNumberWidth = Math.max(lineNumberWidth, parsed.lineNumber.trim().length);
  }
  return { additions, deletions, lineNumberWidth };
}

function formatDiffTableHeader(
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
  lineNumberWidth: number,
): string {
  const labelWidth = Math.max(4, lineNumberWidth + 1);
  const labels = theme.fg("dim", `${"line".padStart(labelWidth)} │ content`);
  const border = theme.fg("dim", `${"─".repeat(labelWidth + 1)}┼${"─".repeat(72)}`);
  return `${labels}\n${border}`;
}

function formatDiffTableLines(
  diff: string,
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
  lineNumberWidth: number,
  expanded = true,
): string[] {
  const lines = splitContentLines(diff);
  const visibleLines = expanded ? lines : compactDiffLines(lines);
  return visibleLines.map((line) => {
    const parsed = parseDisplayDiffLine(line);
    if (!parsed) return theme.fg("toolDiffContext", ` ${"".padStart(lineNumberWidth)} │ ${line}`);

    const labelWidth = Math.max(4, lineNumberWidth + 1);
    const sign = parsed.kind === " " ? " " : parsed.kind;
    const lineNumber = parsed.lineNumber.trim() || "…";
    const label = `${sign}${lineNumber.padStart(lineNumberWidth)}`.padStart(labelWidth);
    const body = replaceTabs(parsed.content);

    if (parsed.kind === "+") {
      return `${theme.fg("toolDiffAdded", label)} ${theme.fg("dim", "│")} ${theme.fg("toolDiffAdded", body)}`;
    }
    if (parsed.kind === "-") {
      return `${theme.fg("toolDiffRemoved", label)} ${theme.fg("dim", "│")} ${theme.fg("toolDiffRemoved", body)}`;
    }
    return `${theme.fg("toolDiffContext", label)} ${theme.fg("dim", "│")} ${theme.fg("toolDiffContext", body)}`;
  });
}

function compactDiffLines(lines: readonly string[]): string[] {
  const changedIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => {
      const parsed = parseDisplayDiffLine(line);
      return parsed?.kind === "+" || parsed?.kind === "-";
    })
    .map(({ index }) => index);
  if (changedIndexes.length === 0) return [...lines];

  const visible = new Set<number>();
  for (const index of changedIndexes) {
    const start = Math.max(0, index - COMPACT_EDIT_CONTEXT_LINES);
    const end = Math.min(lines.length - 1, index + COMPACT_EDIT_CONTEXT_LINES);
    for (let i = start; i <= end; i++) visible.add(i);
  }

  const sorted = [...visible].sort((a, b) => a - b);
  const output: string[] = [];
  if (sorted[0] > 0) output.push("  ...");

  let previous = -1;
  for (const index of sorted) {
    if (previous !== -1 && index > previous + 1) output.push("  ...");
    output.push(lines[index]);
    previous = index;
  }

  if (sorted[sorted.length - 1] < lines.length - 1) output.push("  ...");
  return output;
}

function parseDisplayDiffLine(
  line: string,
): { kind: "+" | "-" | " "; lineNumber: string; content: string } | undefined {
  const match = line.match(/^([+\- ])(\s*\d*)\s(.*)$/);
  if (!match) return undefined;
  return { kind: match[1] as "+" | "-" | " ", lineNumber: match[2], content: match[3] };
}

function replaceTabs(value: string): string {
  return value.replace(/\t/g, "   ");
}

function previewLines(
  text: string,
  maxLines: number,
  strategy: "head" | "tail" | "signal-tail",
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
): string[] {
  const lines = splitContentLines(stripToolFooter(text));
  if (lines.length === 0) return [];

  const signal = lines.filter(isSignalLine);
  const selected =
    strategy === "signal-tail" && signal.length > 0
      ? signal.slice(-maxLines)
      : strategy === "tail" || strategy === "signal-tail"
        ? lines.slice(-maxLines)
        : lines.slice(0, maxLines);

  return styleOutputLines(selected.join("\n"), theme);
}

function styleOutputLines(
  text: string,
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
): string[] {
  return splitContentLines(text).map((line) => {
    const truncated = truncate(line, 180);
    const color = isSignalLine(line) ? "warning" : "toolOutput";
    return theme.fg(color, `  ${truncated}`);
  });
}

function stylePath(
  path: string | undefined,
  theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1],
): string {
  if (!path) return theme.fg("toolOutput", "…");
  return theme.fg("accent", path);
}

function formatReadRange(args: ReadToolInput): string {
  if (args.offset === undefined && args.limit === undefined) return "";
  const start = args.offset ?? 1;
  const end = args.limit === undefined ? "" : start + args.limit - 1;
  return `:${start}${end ? `-${end}` : ""}`;
}

function countContentLines(text: string): number {
  return splitContentLines(stripToolFooter(text)).length;
}

function splitContentLines(text: string): string[] {
  if (!text) return [];
  return text
    .replace(/\n$/, "")
    .split("\n")
    .filter((line) => line.length > 0);
}

function stripToolFooter(text: string): string {
  const footerStart = text.lastIndexOf("\n\n[");
  if (
    footerStart !== -1 &&
    /\b(Full output|Showing lines|Truncated|Use offset|limit reached)\b/i.test(
      text.slice(footerStart),
    )
  ) {
    return text.slice(0, footerStart).trimEnd();
  }
  return text.trimEnd();
}

function truncationNote(
  details: { truncation?: unknown } | undefined,
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
): string | undefined {
  const truncation = details?.truncation as
    | { truncated?: boolean; outputLines?: number; totalLines?: number }
    | undefined;
  if (!truncation?.truncated) return undefined;
  if (typeof truncation.outputLines === "number" && typeof truncation.totalLines === "number") {
    return theme.fg("warning", `↳ truncated ${truncation.outputLines}/${truncation.totalLines}`);
  }
  return theme.fg("warning", "↳ truncated");
}

function bashFailureLabel(text: string): string {
  const lastLine = splitContentLines(text).at(-1);
  if (lastLine?.startsWith("Command ")) return lastLine;
  return "bash failed";
}

function isSignalLine(line: string): boolean {
  return /\b(error|failed|failure|exception|traceback|warning|warn|denied|not found|timeout|timed out)\b|npm ERR!|\bERR!\b|✖|×/i.test(
    line,
  );
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Pure helpers exposed for Node tests. */
export const __toolDisplayForTest = {
  diffLineStats,
  formatDiffTableHeader,
  formatDiffTableLines,
  compactDiffLines,
  parseDisplayDiffLine,
  ToolRail,
};
