export interface CompactToolSummaryInput {
  name: string;
  args: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  started?: boolean;
}

export interface CompactToolSummaryOptions {
  maxArgChars?: number;
  maxErrorChars?: number;
}

const DEFAULT_MAX_ARG_CHARS = 80;
const DEFAULT_MAX_ERROR_CHARS = 120;

/** Format a tool call as one terse overlay line without dumping successful output. */
export function formatCompactToolSummary(
  tool: CompactToolSummaryInput,
  options: CompactToolSummaryOptions = {},
): string {
  const status = tool.result === undefined ? "…" : tool.isError ? "✗" : "✓";
  const argSummary = summarizeArgs(
    tool.name,
    tool.args,
    options.maxArgChars ?? DEFAULT_MAX_ARG_CHARS,
  );
  const resultSummary = summarizeResult(
    tool.result ?? tool.partialResult,
    tool.result !== undefined && tool.isError === true,
    options.maxErrorChars ?? DEFAULT_MAX_ERROR_CHARS,
  );
  return compactJoin([status, tool.name, argSummary, resultSummary ? `· ${resultSummary}` : ""]);
}

function summarizeArgs(name: string, args: unknown, maxChars: number): string {
  const record = asRecord(args);
  if (!record) return "";
  const path = stringValue(record.path) ?? stringValue(record.file) ?? stringValue(record.cwd);
  if (name === "read") {
    const range = [
      record.offset !== undefined ? `from ${record.offset}` : undefined,
      record.limit !== undefined ? `${record.limit} lines` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    return truncate([path, range ? `(${range})` : undefined].filter(Boolean).join(" "), maxChars);
  }
  if (name === "grep") {
    return truncate(
      [quote(stringValue(record.pattern)), path, stringValue(record.glob)]
        .filter(Boolean)
        .join(" in "),
      maxChars,
    );
  }
  if (name === "find") {
    return truncate(
      [quote(stringValue(record.pattern)), path].filter(Boolean).join(" in "),
      maxChars,
    );
  }
  if (name === "ls" || name === "edit" || name === "write") return truncate(path ?? "", maxChars);
  if (name === "bash") return truncate(stringValue(record.command) ?? "", maxChars);
  return truncate(JSON.stringify(args) ?? "", maxChars);
}

function summarizeResult(value: unknown, isError: boolean, maxErrorChars: number): string {
  if (value === undefined) return "";
  const text = resultText(value);
  if (isError) return text ? `error: ${truncate(firstLine(text), maxErrorChars)}` : "error";
  if (!text) return summarizeContentTypes(value);
  const lines = text.split("\n").length;
  const chars = text.length;
  return lines > 1 ? `${lines} lines` : `${chars} chars`;
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  const content = Array.isArray(record?.content) ? record.content : undefined;
  if (!content) return "";
  return content
    .map((part) => {
      const partRecord = asRecord(part);
      return partRecord?.type === "text" && typeof partRecord.text === "string"
        ? partRecord.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeContentTypes(value: unknown): string {
  const record = asRecord(value);
  const content = Array.isArray(record?.content) ? record.content : undefined;
  if (!content?.length) return "";
  const counts = new Map<string, number>();
  for (const part of content) {
    const partRecord = asRecord(part);
    const label = typeof partRecord?.type === "string" ? partRecord.type : "content";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => `${count} ${type}`).join(", ");
}

function compactJoin(parts: string[]): string {
  return parts
    .filter((part) => part.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function quote(value: string | undefined): string | undefined {
  return value ? `“${value}”` : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function truncate(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, Math.max(0, maxChars - 1))}…` : oneLine;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
