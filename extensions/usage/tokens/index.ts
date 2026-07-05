import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export const TOKEN_USAGE_WINDOW_DAYS = 30;

export interface TokenUsageSessionText {
  sessionId: string;
  content: string;
}

export interface TokenUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  responses: number;
  sessions: number;
}

export interface TokenProviderModelUsage {
  providerModel: string;
  provider: string;
  model: string;
  last30d: TokenUsageTotals;
  allTime: TokenUsageTotals;
}

export interface TokenUsageReport {
  generatedAt: number;
  windowDays: number;
  sessionFiles: number;
  providerModels: TokenProviderModelUsage[];
}

/** Read Pi session JSONL files from one directory, optionally recursing through project folders. */
export async function readSessionTexts(
  sessionDir: string,
  recursive = false,
): Promise<TokenUsageSessionText[]> {
  const sessions: TokenUsageSessionText[] = [];
  await collectSessionTexts(sessionDir, sessionDir, recursive, sessions);
  return sessions;
}

/** Aggregate assistant token usage from Pi JSONL session contents by provider/model. */
export function aggregateTokenUsage(
  sessions: readonly TokenUsageSessionText[],
  now = Date.now(),
): TokenUsageReport {
  const cutoff = now - TOKEN_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const buckets = new Map<string, MutableTokenProviderModelUsage>();

  for (const session of sessions) {
    for (const line of session.content.split(/\r?\n/)) {
      const entry = parseJsonLine(line);
      if (!entry || entry.type !== "message") continue;

      const message = asRecord(entry.message);
      if (message?.role !== "assistant") continue;

      const provider = stringField(message, "provider") ?? "unknown";
      const model = stringField(message, "model") ?? "unknown";
      const usage = normalizeTokenUsage(message.usage);
      if (!usage) continue;

      const timestamp = messageTimestamp(message, entry);
      const providerModel = `${provider}/${model}`;
      let bucket = buckets.get(providerModel);
      if (!bucket) {
        bucket = createMutableTokenProviderModelUsage(providerModel, provider, model);
        buckets.set(providerModel, bucket);
      }

      addTokenUsage(bucket.allTime, usage, session.sessionId);
      if (timestamp !== undefined && timestamp >= cutoff)
        addTokenUsage(bucket.last30d, usage, session.sessionId);
    }
  }

  const providerModels = [...buckets.values()]
    .map(finalizeTokenProviderModelUsage)
    .sort(
      (a, b) => b.allTime.total - a.allTime.total || a.providerModel.localeCompare(b.providerModel),
    );

  return {
    generatedAt: now,
    windowDays: TOKEN_USAGE_WINDOW_DAYS,
    sessionFiles: sessions.length,
    providerModels,
  };
}

/** Build display lines for local token usage across many sessions. */
export function buildTokenUsageDetails(
  report: TokenUsageReport,
  sessionDir?: string,
  providerModel?: string,
): string[] {
  const lines = [
    providerModel ? `Token usage for ${providerModel}` : "Token usage by provider/model",
    `window: last ${report.windowDays}d + all-time`,
    `session files: ${report.sessionFiles}`,
  ];
  if (sessionDir) lines.push(`source: ${sessionDir}`);
  lines.push(`fetched: ${formatDateTime(report.generatedAt)}`);

  const providerModels = providerModel
    ? report.providerModels.filter((entry) => entry.providerModel === providerModel)
    : report.providerModels;

  if (providerModels.length === 0) {
    lines.push("", "No assistant token usage found in local sessions.");
    return lines;
  }

  for (const entry of providerModels) {
    lines.push("", entry.providerModel);
    lines.push(`  30d: ${formatTokenTotals(entry.last30d)}`);
    lines.push(`  all: ${formatTokenTotals(entry.allTime)}`);
  }

  return lines;
}

interface NormalizedTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

interface MutableTokenUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  responses: number;
  sessionIds: Set<string>;
}

interface MutableTokenProviderModelUsage {
  providerModel: string;
  provider: string;
  model: string;
  last30d: MutableTokenUsageTotals;
  allTime: MutableTokenUsageTotals;
}

async function collectSessionTexts(
  rootDir: string,
  currentDir: string,
  recursive: boolean,
  sessions: TokenUsageSessionText[],
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) await collectSessionTexts(rootDir, path, recursive, sessions);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

    try {
      sessions.push({
        sessionId: relative(rootDir, path) || entry.name,
        content: await readFile(path, "utf8"),
      });
    } catch {
      // Session files can be moved or rewritten while the report loads; skip races.
    }
  }
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function normalizeTokenUsage(value: unknown): NormalizedTokenUsage | undefined {
  const usage = asRecord(value);
  const input = numberField(usage, "input");
  const output = numberField(usage, "output");
  const totalTokens = numberField(usage, "totalTokens");
  if (input === undefined || output === undefined || totalTokens === undefined) return undefined;

  const cost = asRecord(usage?.cost);
  return {
    input,
    output,
    cacheRead: numberField(usage, "cacheRead") ?? 0,
    cacheWrite: numberField(usage, "cacheWrite") ?? 0,
    total: totalTokens,
    cost: numberField(cost, "total") ?? 0,
  };
}

function messageTimestamp(
  message: Record<string, unknown>,
  entry: Record<string, unknown>,
): number | undefined {
  const timestamp = numberField(message, "timestamp");
  if (timestamp !== undefined) return timestamp;

  const entryTimestamp = stringField(entry, "timestamp");
  if (!entryTimestamp) return undefined;

  const parsed = Date.parse(entryTimestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function createMutableTokenProviderModelUsage(
  providerModel: string,
  provider: string,
  model: string,
): MutableTokenProviderModelUsage {
  return {
    providerModel,
    provider,
    model,
    last30d: createMutableTokenTotals(),
    allTime: createMutableTokenTotals(),
  };
}

function createMutableTokenTotals(): MutableTokenUsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    responses: 0,
    sessionIds: new Set<string>(),
  };
}

function addTokenUsage(
  totals: MutableTokenUsageTotals,
  usage: NormalizedTokenUsage,
  sessionId: string,
): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.total += usage.total;
  totals.cost += usage.cost;
  totals.responses += 1;
  totals.sessionIds.add(sessionId);
}

function finalizeTokenProviderModelUsage(
  bucket: MutableTokenProviderModelUsage,
): TokenProviderModelUsage {
  return {
    providerModel: bucket.providerModel,
    provider: bucket.provider,
    model: bucket.model,
    last30d: finalizeTokenTotals(bucket.last30d),
    allTime: finalizeTokenTotals(bucket.allTime),
  };
}

function finalizeTokenTotals(totals: MutableTokenUsageTotals): TokenUsageTotals {
  return {
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    total: totals.total,
    cost: totals.cost,
    responses: totals.responses,
    sessions: totals.sessionIds.size,
  };
}

function formatTokenTotals(totals: TokenUsageTotals): string {
  return [
    `${compactNumber(totals.total)} tok`,
    `↑${compactNumber(totals.input)}`,
    `↓${compactNumber(totals.output)}`,
    `$${totals.cost.toFixed(3)}`,
    `${totals.responses} responses`,
    `${totals.sessions} sessions`,
  ].join(" · ");
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) < 1000) return `${Math.round(value)}`;
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "unknown";
  return new Date(timestamp).toLocaleString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
