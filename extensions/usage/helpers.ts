export const CHATGPT_BASE_URL = (
  process.env.CHATGPT_BASE_URL || "https://chatgpt.com/backend-api"
).replace(/\/+$/, "");

export const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
export const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";
export const FIVE_HOUR_SECONDS = 5 * 60 * 60;
export const WEEK_SECONDS = 7 * 24 * 60 * 60;
export const TOKEN_USAGE_WINDOW_DAYS = 30;
export const WINDOW_MATCH_TOLERANCE_SECONDS = 120;

export interface UsageWindow {
  usedPercent: number;
  windowSeconds: number;
  resetAt?: number;
}

export interface UsageSnapshot {
  planType?: string;
  email?: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  fetchedAt: number;
}

export interface TokenMetadata {
  accountId?: string;
  planType?: string;
  email?: string;
}

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

/** Return true for Pi's ChatGPT OAuth-backed Codex provider names. */
export function isOpenAICodexProvider(provider: string | undefined): boolean {
  return provider === "openai-codex" || /^openai-codex-\d+$/.test(provider ?? "");
}

/** Decode ChatGPT account metadata from Pi's OpenAI Codex OAuth access token. */
export function getTokenMetadata(token: string): TokenMetadata {
  const payload = decodeJwtPayload(token);
  const auth = asRecord(payload?.[OPENAI_AUTH_CLAIM]);
  const profile = asRecord(payload?.[OPENAI_PROFILE_CLAIM]);

  return {
    accountId: stringField(auth, "chatgpt_account_id"),
    planType: stringField(auth, "chatgpt_plan_type"),
    email: stringField(profile, "email"),
  };
}

/** Normalize the ChatGPT WHAM usage response into the fields shown by /usage. */
export function parseUsageSnapshot(data: unknown, fetchedAt = Date.now()): UsageSnapshot {
  const raw = asRecord(data);
  const rateLimit = asRecord(raw?.rate_limit);
  const windows = [
    normalizeWindow(rateLimit?.primary_window),
    normalizeWindow(rateLimit?.secondary_window),
  ].filter((window): window is UsageWindow => window !== undefined);

  return {
    planType: stringField(raw, "plan_type"),
    email: stringField(raw, "email"),
    fiveHour: windows.find((window) => matchesWindow(window, FIVE_HOUR_SECONDS)),
    weekly: windows.find((window) => matchesWindow(window, WEEK_SECONDS)),
    fetchedAt,
  };
}

/** Build concise display lines for the usage picker leaf. */
export function buildUsageDetails(snapshot: UsageSnapshot, provider: string | undefined): string[] {
  const lines = [`provider: ${provider || "unknown"}`, `plan: ${snapshot.planType || "unknown"}`];

  lines.push(`email: ${snapshot.email || "unknown"}`);
  lines.push(`5-hour: ${formatWindow(snapshot.fiveHour)}`);
  lines.push(`weekly: ${formatWindow(snapshot.weekly)}`);
  lines.push(`fetched: ${formatDateTime(snapshot.fetchedAt)}`);
  lines.push(`endpoint: ${CHATGPT_BASE_URL}/wham/usage`);
  return lines;
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

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;

  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const value = JSON.parse(decoded) as unknown;
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function normalizeWindow(value: unknown): UsageWindow | undefined {
  const record = asRecord(value);
  const usedPercent = numberField(record, "used_percent");
  const windowSeconds = numberField(record, "limit_window_seconds");
  const resetAt = numberField(record, "reset_at");

  if (usedPercent === undefined || windowSeconds === undefined) return undefined;
  return { usedPercent, windowSeconds, resetAt };
}

function matchesWindow(window: UsageWindow, seconds: number): boolean {
  return Math.abs(window.windowSeconds - seconds) <= WINDOW_MATCH_TOLERANCE_SECONDS;
}

function formatWindow(window: UsageWindow | undefined): string {
  if (!window) return "unknown";
  const used = clampPercent(window.usedPercent);
  const remaining = clampPercent(100 - window.usedPercent);
  return `${used}% used, ${remaining}% left, resets ${formatReset(window.resetAt)}`;
}

function clampPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}

function formatReset(resetAt: number | undefined): string {
  if (!resetAt) return "unknown";

  const minutes = Math.max(0, Math.round((resetAt * 1000 - Date.now()) / 60000));
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;

  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

function formatDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "unknown";
  return new Date(timestamp).toLocaleString();
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
