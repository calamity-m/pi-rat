import type { OverlayPanelTheme } from "../lib/overlay.ts";
import type { SubagentRun, SubagentRunStatus } from "./types.ts";
import { formatElapsed } from "./store.ts";

/** Theme surface needed for transcript rendering. */
export interface TranscriptTheme extends Omit<OverlayPanelTheme, "fg"> {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Build themed transcript lines from a retained nested-session message list. */
export function buildTranscriptLines(run: SubagentRun, theme: TranscriptTheme): string[] {
  const lines = [
    `${theme.fg("accent", theme.bold(run.id))} ${theme.fg(statusColor(run.status), run.status.toUpperCase())}`,
    `${theme.fg("muted", "model:")} ${theme.fg("accent", run.modelId)}${run.thinkingLevel ? theme.fg("muted", `:${run.thinkingLevel}`) : ""} ${theme.fg("muted", `tools:${run.tools}`)}${run.presetAgentName ? theme.fg("muted", ` agent:${run.presetAgentName}`) : ""}`,
    `${theme.fg("muted", "elapsed:")} ${theme.fg("dim", formatElapsed(run))}`,
    "",
    theme.fg("border", "─── Task ───"),
    ...colorBlock(run.task, theme, "text"),
    "",
  ];

  if (!run.transcript?.length) {
    lines.push(theme.fg("warning", "Transcript is not available yet."));
    if (run.error) lines.push("", theme.fg("warning", run.error));
    if (run.finalText)
      lines.push(
        "",
        theme.fg("border", "─── Final ───"),
        ...colorBlock(run.finalText, theme, "toolOutput"),
      );
    return lines;
  }

  run.transcript.forEach((message, index) => {
    if (index > 0) lines.push("");
    appendMessageLines(lines, message, theme);
  });
  return lines;
}

/** Append one colored message block to the transcript. */
function appendMessageLines(lines: string[], rawMessage: unknown, theme: TranscriptTheme): void {
  const message = asRecord(rawMessage);
  const role = typeof message?.role === "string" ? message.role : "unknown";
  lines.push(formatMessageHeader(role, message, theme));

  if (role === "assistant" && Array.isArray(message?.content)) {
    for (const part of message.content) appendContentPart(lines, part, theme, "toolOutput");
    return;
  }
  if (role === "toolResult") {
    const content =
      Array.isArray(message?.content) || typeof message?.content === "string"
        ? message.content
        : [];
    appendContent(lines, content, theme, message?.isError === true ? "error" : "toolOutput");
    return;
  }
  if (role === "user" || role === "custom") {
    appendContent(lines, message?.content, theme, "text");
    return;
  }
  lines.push(...colorBlock(JSON.stringify(rawMessage, null, 2), theme, "dim"));
}

/** Return a colored message header for transcript navigation. */
function formatMessageHeader(
  role: string,
  message: Record<string, unknown> | undefined,
  theme: TranscriptTheme,
): string {
  if (role === "assistant") return theme.fg("accent", theme.bold("─── assistant ───"));
  if (role === "user") return theme.fg("text", theme.bold("─── user ───"));
  if (role === "toolResult") {
    const toolName = typeof message?.toolName === "string" ? message.toolName : "tool";
    const isError = message?.isError === true;
    return theme.fg(
      isError ? "warning" : "accent",
      theme.bold(`─── tool result: ${toolName} ${isError ? "✗" : "✓"} ───`),
    );
  }
  return theme.fg("muted", theme.bold(`─── ${role} ───`));
}

/** Append content blocks or string content to transcript lines. */
function appendContent(
  lines: string[],
  content: unknown,
  theme: TranscriptTheme,
  color: string,
): void {
  if (typeof content === "string") {
    lines.push(...colorBlock(content, theme, color));
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) appendContentPart(lines, part, theme, color);
}

/** Append one content part with role-appropriate coloring. */
function appendContentPart(
  lines: string[],
  rawPart: unknown,
  theme: TranscriptTheme,
  color: string,
): void {
  const part = asRecord(rawPart);
  if (!part || typeof part.type !== "string") {
    lines.push(theme.fg("dim", JSON.stringify(rawPart)));
    return;
  }
  if (part.type === "text" && typeof part.text === "string") {
    lines.push(...colorBlock(part.text, theme, color));
  } else if (part.type === "thinking" && typeof part.thinking === "string") {
    lines.push(theme.fg("muted", "thinking:"), ...colorBlock(part.thinking, theme, "dim"));
  } else if (part.type === "toolCall") {
    const name = typeof part.name === "string" ? part.name : "tool";
    lines.push(theme.fg("accent", `→ ${name}`));
    lines.push(...colorBlock(JSON.stringify(part.arguments ?? {}, null, 2), theme, "dim"));
  } else if (part.type === "image") {
    const mime = typeof part.mimeType === "string" ? part.mimeType : "image";
    lines.push(theme.fg("warning", `[${mime} omitted]`));
  } else {
    lines.push(...colorBlock(JSON.stringify(rawPart, null, 2), theme, "dim"));
  }
}

/** Color each line of a text block independently so wrapping preserves styles. */
export function colorBlock(text: string, theme: TranscriptTheme, color: string): string[] {
  const rawLines = text.split("\n");
  return rawLines.length > 0
    ? rawLines.map((line) => theme.fg(color, line || " "))
    : [theme.fg(color, " ")];
}

/** Return the best status color token for a run state. */
export function statusColor(status: SubagentRunStatus): string {
  if (status === "done") return "accent";
  if (status === "error") return "warning";
  if (status === "aborted") return "warning";
  return "accent";
}

/** Narrow unknown JSON-ish values to object records. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
