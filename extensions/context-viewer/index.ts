import type {
  BuildSystemPromptOptions,
  ContextUsage,
  ExtensionAPI,
  ExtensionCommandContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";

import {
  NestedPickerPanel,
  type NestedPickerPanelTheme,
  type NestedPickerRow,
} from "../lib/nested-picker-panel.ts";
import { currentThinkingBorderColor } from "../lib/thinking-border.ts";

const GRID_ROWS = 8;
const GRID_COLUMNS = 11;
const GRID_CELLS = GRID_ROWS * GRID_COLUMNS;
const PREVIEW_LIMIT = 420;

type MessageRole =
  | "user"
  | "assistant"
  | "toolResult"
  | "custom"
  | "bashExecution"
  | "summary"
  | "other";

interface BreakdownInput {
  branchEntries: readonly unknown[];
  systemPrompt: string;
  promptOptions: BuildSystemPromptOptions;
  allTools: readonly ToolInfo[];
  activeTools: readonly string[];
  contextUsage?: ContextUsage;
  model?: { provider?: string; id?: string; contextWindow?: number; maxTokens?: number };
}

export interface ContextBreakdown {
  summary: ContextSummary;
  sections: ContextSection[];
}

export interface ContextSummary {
  contextTokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  approximateTokens: number;
  approximateChars: number;
  modelLabel: string;
  dotgrid: string[];
}

export interface ContextSection {
  id: string;
  label: string;
  description: string;
  chars: number;
  approxTokens: number;
  details: DetailLine[];
  children?: ContextSection[];
}

interface DetailLine {
  text: string;
  tone?: "heading" | "muted" | "dim" | "success" | "warning" | "error" | "accent";
}

interface GridOptions {
  usedPercent: number | null;
  outputReservePercent?: number | null;
  markerPercent?: number | null;
}

interface RowValue {
  section: ContextSection | "summary";
}

/** Register the /context command for inspecting current-session context usage. */
export default function contextViewerExtension(pi: ExtensionAPI): void {
  pi.registerCommand("context", {
    description: "Show current session context breakdown",
    handler: async (_args, ctx) => {
      const breakdown = buildContextBreakdown({
        branchEntries: ctx.sessionManager.getBranch(),
        systemPrompt: ctx.getSystemPrompt(),
        promptOptions: ctx.getSystemPromptOptions(),
        allTools: pi.getAllTools(),
        activeTools: pi.getActiveTools(),
        contextUsage: ctx.getContextUsage(),
        model: ctx.model,
      });

      if (ctx.mode === "tui") {
        await showContextPicker(ctx, breakdown);
        return;
      }

      if (ctx.hasUI) ctx.ui.notify(fallbackReport(breakdown).join("\n"), "info");
    },
  });
}

export function buildContextBreakdown(input: BreakdownInput): ContextBreakdown {
  const messageSection = buildMessagesSection(input.branchEntries);
  const systemSection = buildSystemPromptSection(input.systemPrompt, input.promptOptions);
  const toolSection = buildToolsSection(input.allTools, input.activeTools, input.promptOptions);
  const contextFilesSection = buildContextFilesSection(input.promptOptions);
  const skillsSection = buildSkillsSection(input.promptOptions);
  const otherSection = buildOtherEntriesSection(input.branchEntries);

  const sections = [
    messageSection,
    systemSection,
    toolSection,
    contextFilesSection,
    skillsSection,
    otherSection,
  ];
  const approximateChars = sections.reduce((sum, section) => sum + section.chars, 0);
  const approximateTokens = estimateCharTokens(approximateChars);
  const usageTokens = input.contextUsage?.tokens ?? null;
  const contextWindow = input.contextUsage?.contextWindow ?? input.model?.contextWindow ?? null;
  const percent = input.contextUsage?.percent ?? percentOf(approximateTokens, contextWindow);
  const outputReservePercent = percentOf(input.model?.maxTokens ?? null, contextWindow);
  const markerPercent = percentOf(
    systemSection.approxTokens + toolSection.approxTokens,
    contextWindow,
  );

  return {
    summary: {
      contextTokens: usageTokens,
      contextWindow,
      percent,
      approximateTokens,
      approximateChars,
      modelLabel: modelLabel(input.model),
      dotgrid: renderContextDotgrid({ usedPercent: percent, outputReservePercent, markerPercent }),
    },
    sections,
  };
}

export function renderContextDotgrid(options: GridOptions): string[] {
  const usedCells = clampCellCount(
    options.usedPercent == null ? 0 : Math.ceil((options.usedPercent / 100) * GRID_CELLS),
  );
  const reserveCells = clampCellCount(
    options.outputReservePercent == null
      ? 0
      : Math.round((options.outputReservePercent / 100) * GRID_CELLS),
  );
  const markerIndex =
    options.markerPercent == null
      ? -1
      : Math.max(
          0,
          Math.min(GRID_CELLS - 1, Math.round((options.markerPercent / 100) * GRID_CELLS) - 1),
        );

  const cells: string[] = [];
  for (let i = 0; i < GRID_CELLS; i++) {
    const reserveStart = GRID_CELLS - reserveCells;
    if (i < usedCells) cells.push("●");
    else if (reserveCells > 0 && i >= reserveStart) cells.push("○");
    else cells.push("·");
  }

  if (usedCells > 0) cells[0] = "◍";
  if (markerIndex >= 0 && markerIndex < usedCells) cells[markerIndex] = "⚙";

  const lines: string[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    const start = row * GRID_COLUMNS;
    lines.push(cells.slice(start, start + GRID_COLUMNS).join(" "));
  }
  return lines;
}

export function estimateTextTokens(text: string): number {
  return estimateCharTokens(text.length);
}

export function estimateCharTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

export function formatApproxTokens(tokens: number): string {
  return `~${formatNumber(tokens)} tokens`;
}

function buildMessagesSection(entries: readonly unknown[]): ContextSection {
  const messageEntries = entries.filter((entry) => getEntryType(entry) === "message");
  const roleGroups = new Map<MessageRole, unknown[]>();
  for (const entry of messageEntries) {
    const role = messageRole(getMessage(entry));
    roleGroups.set(role, [...(roleGroups.get(role) ?? []), entry]);
  }

  const children = [...roleGroups.entries()].map(([role, roleEntries]) =>
    buildRoleSection(role, roleEntries),
  );
  const text = messageEntries.map((entry) => messageText(getMessage(entry))).join("\n");
  return makeSection({
    id: "messages",
    label: "Messages",
    description: `${messageEntries.length} context messages, ${formatApproxTokens(estimateTextTokens(text))}`,
    text,
    details: [
      heading("Messages"),
      line(`${messageEntries.length} message entries on the active branch.`),
      dim(
        "Grouped by role. Assistant tool calls and tool results are grouped again by tool usage.",
      ),
    ],
    children,
  });
}

function buildRoleSection(role: MessageRole, entries: readonly unknown[]): ContextSection {
  const text = entries.map((entry) => messageText(getMessage(entry))).join("\n");
  const children =
    role === "assistant"
      ? buildAssistantToolCallSections(entries)
      : role === "toolResult"
        ? buildToolResultSections(entries)
        : entries.map((entry, index) =>
            buildEntrySection(`${role}-${index}`, roleLabel(role), entry),
          );

  return makeSection({
    id: `messages-${role}`,
    label: roleLabel(role),
    description: `${entries.length} entries, ${formatApproxTokens(estimateTextTokens(text))}`,
    text,
    details: [heading(roleLabel(role)), line(`${entries.length} entries.`), preview(text)],
    children,
  });
}

function buildAssistantToolCallSections(entries: readonly unknown[]): ContextSection[] {
  const toolCallSections: ContextSection[] = [];
  const plainAssistantSections: ContextSection[] = [];

  entries.forEach((entry, entryIndex) => {
    const message = getMessage(entry);
    const toolCalls = extractToolCalls(message);
    if (toolCalls.length === 0) {
      plainAssistantSections.push(
        buildEntrySection(`assistant-${entryIndex}`, "Assistant message", entry),
      );
      return;
    }

    const textContent = assistantNonToolText(message);
    if (textContent) {
      plainAssistantSections.push(
        makeSection({
          id: `assistant-text-${entryIndex}`,
          label: "Assistant text",
          description: `${formatApproxTokens(estimateTextTokens(textContent))}`,
          text: textContent,
          details: [heading("Assistant text"), preview(textContent)],
        }),
      );
    }

    toolCalls.forEach((call, callIndex) => {
      const text = stableJson(call.arguments);
      toolCallSections.push(
        makeSection({
          id: `assistant-tool-${call.id ?? entryIndex}-${callIndex}`,
          label: call.name ?? "tool call",
          description: `tool call ${call.id ?? "unknown"}, ${formatApproxTokens(estimateTextTokens(text))}`,
          text,
          details: [
            heading(call.name ?? "tool call"),
            line(`toolCallId: ${call.id ?? "unknown"}`),
            line(`arguments: ${formatApproxTokens(estimateTextTokens(text))}`),
            preview(text),
          ],
        }),
      );
    });
  });

  return [...toolCallSections, ...plainAssistantSections];
}

function buildToolResultSections(entries: readonly unknown[]): ContextSection[] {
  const grouped = new Map<string, { toolName: string; toolCallId: string; entries: unknown[] }>();
  for (const entry of entries) {
    const message = getMessage(entry) as Record<string, unknown> | undefined;
    const toolName = String(message?.toolName ?? "tool");
    const toolCallId = String(message?.toolCallId ?? "unknown");
    const key = stableJson({ toolName, toolCallId });
    const existing = grouped.get(key) ?? { toolName, toolCallId, entries: [] };
    existing.entries.push(entry);
    grouped.set(key, existing);
  }

  return [...grouped.values()].map(({ toolName, toolCallId, entries: group }) => {
    const groupId = `${toolName}-${toolCallId}`;
    const text = group.map((entry) => messageText(getMessage(entry))).join("\n");
    return makeSection({
      id: `tool-result-${slug(groupId)}`,
      label: toolName,
      description: `${group.length} result(s), call ${toolCallId}, ${formatApproxTokens(estimateTextTokens(text))}`,
      text,
      details: [
        heading(toolName),
        line(`toolCallId: ${toolCallId}`),
        line(`${group.length} result message(s).`),
        preview(text),
      ],
      children: group.map((entry, index) =>
        buildEntrySection(`tool-result-${slug(groupId)}-${index}`, "Tool result", entry),
      ),
    });
  });
}

function buildEntrySection(id: string, label: string, entry: unknown): ContextSection {
  const message = getMessage(entry);
  const text = message ? messageText(message) : stableJson(entry);
  const entryId = getEntryId(entry);
  return makeSection({
    id: `${id}-${entryId ?? "entry"}`,
    label: entryId ? `${label} ${entryId}` : label,
    description: `${formatApproxTokens(estimateTextTokens(text))}`,
    text,
    details: [
      heading(label),
      ...(entryId ? [line(`entry: ${entryId}`)] : []),
      ...(message ? [line(`role: ${messageRole(message)}`)] : []),
      preview(text),
    ],
  });
}

function buildSystemPromptSection(
  systemPrompt: string,
  options: BuildSystemPromptOptions,
): ContextSection {
  const children = [
    textChild("system-custom", "Custom prompt", options.customPrompt),
    textChild("system-append", "Appended prompt", options.appendSystemPrompt),
    listChild("system-guidelines", "Prompt guidelines", options.promptGuidelines),
    listChild(
      "system-tool-snippets",
      "Tool snippets",
      Object.entries(options.toolSnippets ?? {}).map(([name, text]) => `${name}: ${text}`),
    ),
  ].filter((section): section is ContextSection => Boolean(section));

  return makeSection({
    id: "system-prompt",
    label: "System Prompt",
    description: `${formatApproxTokens(estimateTextTokens(systemPrompt))}, ${formatNumber(systemPrompt.length)} chars`,
    text: systemPrompt,
    details: [
      heading("System Prompt"),
      line(
        `${formatNumber(systemPrompt.length)} chars / ${formatApproxTokens(estimateTextTokens(systemPrompt))}.`,
      ),
      dim(
        "This is Pi's current command-visible system prompt, before provider-specific payload rewrites.",
      ),
      preview(systemPrompt),
    ],
    children,
  });
}

function buildToolsSection(
  allTools: readonly ToolInfo[],
  activeTools: readonly string[],
  options: BuildSystemPromptOptions,
): ContextSection {
  const active = new Set(activeTools);
  const grouped = new Map<string, ToolInfo[]>();
  for (const tool of allTools) {
    const source = tool.sourceInfo?.source ?? "unknown";
    grouped.set(source, [...(grouped.get(source) ?? []), tool]);
  }

  const children = [...grouped.entries()].map(([source, tools]) => {
    const toolChildren = tools.map((tool) =>
      buildToolSection(tool, active.has(tool.name), options),
    );
    const text = tools.map((tool) => toolText(tool, options)).join("\n");
    return makeSection({
      id: `tools-${slug(source)}`,
      label: source,
      description: `${tools.length} tools (${tools.filter((tool) => active.has(tool.name)).length} active), ${formatApproxTokens(estimateTextTokens(text))}`,
      text,
      details: [
        heading(source),
        line(`${tools.length} configured tools.`),
        line(`${tools.filter((tool) => active.has(tool.name)).length} active in prompt.`),
      ],
      children: toolChildren,
    });
  });

  const text = allTools.map((tool) => toolText(tool, options)).join("\n");
  return makeSection({
    id: "tools",
    label: "Tools",
    description: `${allTools.length} configured, ${active.size} active, ${formatApproxTokens(estimateTextTokens(text))}`,
    text,
    details: [
      heading("Tools"),
      line(`${allTools.length} configured tools.`),
      line(`${active.size} active tools.`),
      dim(
        "Grouped by tool provenance. Tool rows include snippet, guidelines, description, and parameter schema size.",
      ),
    ],
    children,
  });
}

function buildToolSection(
  tool: ToolInfo,
  active: boolean,
  options: BuildSystemPromptOptions,
): ContextSection {
  const text = toolText(tool, options);
  const snippet = options.toolSnippets?.[tool.name];
  return makeSection({
    id: `tool-${slug(tool.name)}`,
    label: `${active ? "●" : "○"} ${tool.name}`,
    description: `${active ? "active" : "inactive"}, ${formatApproxTokens(estimateTextTokens(text))}`,
    text,
    details: [
      heading(tool.name),
      {
        text: active ? "active in current prompt" : "not active in current prompt",
        tone: active ? "success" : "muted",
      },
      line(
        `source: ${tool.sourceInfo?.source ?? "unknown"} (${tool.sourceInfo?.scope ?? "unknown"})`,
      ),
      ...(snippet ? [line(`snippet: ${snippet}`)] : []),
      ...(tool.description ? [line(`description: ${tool.description}`)] : []),
      ...(tool.promptGuidelines?.length
        ? [line(`guidelines: ${tool.promptGuidelines.length}`)]
        : []),
      line(
        `parameter schema: ${formatApproxTokens(estimateTextTokens(stableJson(tool.parameters)))}`,
      ),
      preview(text),
    ],
  });
}

function buildContextFilesSection(options: BuildSystemPromptOptions): ContextSection {
  const files = options.contextFiles ?? [];
  const children = files.map((file) =>
    makeSection({
      id: `context-file-${slug(file.path)}`,
      label: file.path,
      description: `${formatApproxTokens(estimateTextTokens(file.content))}, ${formatNumber(file.content.length)} chars`,
      text: file.content,
      details: [
        heading(file.path),
        line(`${formatNumber(file.content.length)} chars.`),
        preview(file.content),
      ],
    }),
  );
  const text = files.map((file) => `${file.path}\n${file.content}`).join("\n");
  return makeSection({
    id: "context-files",
    label: "Context Files",
    description: `${files.length} files, ${formatApproxTokens(estimateTextTokens(text))}`,
    text,
    details: [heading("Context Files"), line(`${files.length} loaded context files.`)],
    children,
  });
}

function buildSkillsSection(options: BuildSystemPromptOptions): ContextSection {
  const skills = options.skills ?? [];
  const children = skills.map((skill) => {
    const text = stableJson(skill);
    return makeSection({
      id: `skill-${slug(skill.name)}`,
      label: skill.name,
      description: `${skill.disableModelInvocation ? "explicit only" : "model-visible"}, ${formatApproxTokens(estimateTextTokens(text))}`,
      text,
      details: [
        heading(skill.name),
        line(skill.description),
        line(`file: ${skill.filePath}`),
        {
          text: skill.disableModelInvocation ? "explicit invocation only" : "available to model",
          tone: skill.disableModelInvocation ? "muted" : "success",
        },
      ],
    });
  });
  const text = skills.map((skill) => stableJson(skill)).join("\n");
  return makeSection({
    id: "skills",
    label: "Skills",
    description: `${skills.length} loaded, ${formatApproxTokens(estimateTextTokens(text))}`,
    text,
    details: [heading("Skills"), line(`${skills.length} loaded skills.`)],
    children,
  });
}

function buildOtherEntriesSection(entries: readonly unknown[]): ContextSection {
  const others = entries.filter((entry) => getEntryType(entry) !== "message");
  const children = others.map((entry, index) =>
    buildEntrySection(`other-${index}`, getEntryType(entry) ?? "Other entry", entry),
  );
  const text = others.map(stableJson).join("\n");
  return makeSection({
    id: "other-entries",
    label: "Other Session Entries",
    description: `${others.length} entries, ${formatApproxTokens(estimateTextTokens(text))}`,
    text,
    details: [
      heading("Other Session Entries"),
      line(`${others.length} non-message entries on the active branch.`),
    ],
    children,
  });
}

function makeSection(input: {
  id: string;
  label: string;
  description: string;
  text: string;
  details: DetailLine[];
  children?: ContextSection[];
}): ContextSection {
  const chars = input.text.length;
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    chars,
    approxTokens: estimateTextTokens(input.text),
    details: input.details,
    children: input.children,
  };
}

function textChild(
  id: string,
  label: string,
  text: string | undefined,
): ContextSection | undefined {
  if (!text) return undefined;
  return makeSection({
    id,
    label,
    description: `${formatApproxTokens(estimateTextTokens(text))}`,
    text,
    details: [heading(label), preview(text)],
  });
}

function listChild(
  id: string,
  label: string,
  values: readonly string[] | undefined,
): ContextSection | undefined {
  if (!values?.length) return undefined;
  const text = values.join("\n");
  return makeSection({
    id,
    label,
    description: `${values.length} items, ${formatApproxTokens(estimateTextTokens(text))}`,
    text,
    details: [heading(label), ...values.map((value) => line(`• ${value}`))],
  });
}

async function showContextPicker(
  ctx: ExtensionCommandContext,
  breakdown: ContextBreakdown,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    return new NestedPickerPanel<RowValue>({
      title: "context",
      rows: breakdownRows(breakdown),
      enableSearch: true,
      visibleRows: 9,
      leafVisibleRows: 22,
      theme,
      keybindings,
      requestRender: () => tui.requestRender(),
      borderColor: currentThinkingBorderColor(ctx, theme),
      onCancel: () => done(),
      renderRow: (row, context) => renderPickerRow(row, context.selected, theme),
      renderContent: ({ row }) => renderLeaf(row.value?.section ?? "summary", breakdown, theme),
    });
  });
}

function breakdownRows(breakdown: ContextBreakdown): NestedPickerRow<RowValue>[] {
  return [
    {
      id: "summary",
      label: "Summary",
      description: summaryDescription(breakdown.summary),
      value: { section: "summary" },
    },
    ...breakdown.sections.map(sectionToRow),
  ];
}

function sectionToRow(section: ContextSection): NestedPickerRow<RowValue> {
  return {
    id: section.id,
    label: section.label,
    description: section.description,
    value: { section },
    children: section.children?.map(sectionToRow),
  };
}

function renderPickerRow(
  row: NestedPickerRow<RowValue>,
  selected: boolean,
  theme: NestedPickerPanelTheme,
): string {
  const section = row.value?.section;
  const branchMarker = row.children?.length ? "›" : " ";
  const tokenText =
    section && section !== "summary" ? formatApproxTokens(section.approxTokens) : "";
  const label = selected ? theme.fg("accent", row.label) : row.label;
  const description = row.description ? theme.fg("muted", ` — ${row.description}`) : "";
  const tokens = tokenText ? theme.fg("dim", ` ${tokenText}`) : "";
  return `${branchMarker} ${label}${description}${tokens}`;
}

function renderLeaf(
  value: ContextSection | "summary",
  breakdown: ContextBreakdown,
  theme: NestedPickerPanelTheme,
): string[] {
  if (value === "summary") return renderSummaryLeaf(breakdown, theme);
  return [
    theme.fg("accent", value.label),
    theme.fg("dim", value.description),
    "",
    ...value.details.map((detail) => colorDetail(detail, theme)),
  ];
}

function renderSummaryLeaf(breakdown: ContextBreakdown, theme: NestedPickerPanelTheme): string[] {
  const summary = breakdown.summary;
  const topSections = breakdown.sections
    .map(
      (section) =>
        `${section.label.padEnd(22)} ${formatApproxTokens(section.approxTokens).padStart(14)}  ${formatNumber(section.chars)} chars`,
    )
    .map((line) => theme.fg("muted", line));

  return [
    theme.fg("accent", "Context summary"),
    theme.fg("dim", summaryDescription(summary)),
    "",
    ...summary.dotgrid.map((line) => colorGridLine(line, theme)),
    "",
    legend(theme),
    "",
    theme.fg("accent", "Top-level approximate sections"),
    ...topSections,
    "",
    theme.fg(
      "dim",
      "Section totals are approximate chars/4 estimates. Top-level usage comes from Pi when available.",
    ),
  ];
}

function colorGridLine(line: string, theme: NestedPickerPanelTheme): string {
  return line
    .split(" ")
    .map((cell) => {
      if (cell === "◍") return theme.fg("accent", cell);
      if (cell === "⚙") return theme.fg("warning", cell);
      if (cell === "●") return theme.fg("success", cell);
      if (cell === "○") return theme.fg("muted", cell);
      return theme.fg("dim", cell);
    })
    .join(" ");
}

function legend(theme: NestedPickerPanelTheme): string {
  return [
    `${theme.fg("accent", "◍")} current`,
    `${theme.fg("success", "●")} used`,
    `${theme.fg("warning", "⚙")} prompt/tools marker`,
    `${theme.fg("dim", "·")} free`,
    `${theme.fg("muted", "○")} output reserve`,
  ].join("  ");
}

function fallbackReport(breakdown: ContextBreakdown): string[] {
  return [
    "Context summary",
    summaryDescription(breakdown.summary),
    ...breakdown.summary.dotgrid,
    "",
    ...breakdown.sections.map(
      (section) =>
        `${section.label}: ${formatApproxTokens(section.approxTokens)} (${formatNumber(section.chars)} chars)`,
    ),
  ];
}

function summaryDescription(summary: ContextSummary): string {
  const usage =
    summary.contextTokens == null
      ? `${formatApproxTokens(summary.approximateTokens)} estimated locally`
      : `${formatNumber(summary.contextTokens)} / ${formatNumber(summary.contextWindow ?? 0)} tokens`;
  const percent = summary.percent == null ? "unknown" : `${summary.percent.toFixed(1)}%`;
  return `${summary.modelLabel}: ${usage} (${percent})`;
}

function colorDetail(detail: DetailLine, theme: NestedPickerPanelTheme): string {
  switch (detail.tone) {
    case "heading":
      return theme.fg("accent", detail.text);
    case "muted":
      return theme.fg("muted", detail.text);
    case "dim":
      return theme.fg("dim", detail.text);
    case "success":
      return theme.fg("success", detail.text);
    case "warning":
      return theme.fg("warning", detail.text);
    case "error":
      return theme.fg("error", detail.text);
    case "accent":
      return theme.fg("accent", detail.text);
    default:
      return detail.text;
  }
}

function heading(text: string): DetailLine {
  return { text, tone: "heading" };
}

function line(text: string): DetailLine {
  return { text };
}

function dim(text: string): DetailLine {
  return { text, tone: "dim" };
}

function preview(text: string): DetailLine {
  const clean = text.replace(/\s+/g, " ").trim();
  return {
    text: clean.length > PREVIEW_LIMIT ? `${clean.slice(0, PREVIEW_LIMIT)}…` : clean || "(empty)",
    tone: "muted",
  };
}

function toolText(tool: ToolInfo, options: BuildSystemPromptOptions): string {
  return [
    tool.name,
    tool.description ?? "",
    options.toolSnippets?.[tool.name] ?? "",
    ...(tool.promptGuidelines ?? []),
    stableJson(tool.parameters),
    stableJson(tool.sourceInfo),
  ].join("\n");
}

function messageText(message: unknown): string {
  const record = asRecord(message);
  if (!record) return stableJson(message);
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) {
    return record.content.map(contentBlockText).join("\n");
  }
  if (record.role === "bashExecution")
    return `${String(record.command ?? "")}\n${String(record.output ?? "")}`;
  return stableJson(record);
}

function contentBlockText(block: unknown): string {
  const record = asRecord(block);
  if (!record) return stableJson(block);
  if (record.type === "text") return String(record.text ?? "");
  if (record.type === "thinking") return String(record.thinking ?? "");
  if (record.type === "toolCall")
    return `${String(record.name ?? "toolCall")} ${stableJson(record.arguments)}`;
  if (record.type === "image")
    return `[image ${String(record.mimeType ?? "") || String(record.mediaType ?? "")}]`;
  return stableJson(record);
}

function assistantNonToolText(message: unknown): string {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => asRecord(block)?.type !== "toolCall")
    .map(contentBlockText)
    .join("\n")
    .trim();
}

function extractToolCalls(
  message: unknown,
): Array<{ id?: string; name?: string; arguments?: unknown }> {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .map(asRecord)
    .filter(
      (block): block is Record<string, unknown> => block !== undefined && block.type === "toolCall",
    )
    .map((block) => ({
      id: typeof block.id === "string" ? block.id : undefined,
      name: typeof block.name === "string" ? block.name : undefined,
      arguments: block.arguments,
    }));
}

function getEntryType(entry: unknown): string | undefined {
  const type = asRecord(entry)?.type;
  return typeof type === "string" ? type : undefined;
}

function getEntryId(entry: unknown): string | undefined {
  const id = asRecord(entry)?.id;
  return typeof id === "string" ? id : undefined;
}

function getMessage(entry: unknown): unknown {
  return asRecord(entry)?.message;
}

function messageRole(message: unknown): MessageRole {
  const record = asRecord(message);
  if (!record) return "other";
  switch (record.role) {
    case "user":
    case "assistant":
    case "toolResult":
    case "custom":
    case "bashExecution":
      return record.role;
    case "branchSummary":
    case "compactionSummary":
      return "summary";
    default:
      return "other";
  }
}

function roleLabel(role: MessageRole): string {
  switch (role) {
    case "toolResult":
      return "Tool Results";
    case "bashExecution":
      return "User Bash";
    default:
      return `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
  }
}

function stableJson(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_key, nested) => {
        if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
        return Object.fromEntries(
          Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        );
      },
      2,
    ) ?? ""
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function percentOf(
  value: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (!value || !total || total <= 0) return null;
  return (value / total) * 100;
}

function clampCellCount(value: number): number {
  return Math.max(0, Math.min(GRID_CELLS, value));
}

function modelLabel(model: BreakdownInput["model"]): string {
  if (!model) return "unknown model";
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  return model.id ?? model.provider ?? "unknown model";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "unknown"
  );
}
