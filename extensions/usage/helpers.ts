export const CHATGPT_BASE_URL = (
  process.env.CHATGPT_BASE_URL || "https://chatgpt.com/backend-api"
).replace(/\/+$/, "");

export const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
export const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";
export const FIVE_HOUR_SECONDS = 5 * 60 * 60;
export const WEEK_SECONDS = 7 * 24 * 60 * 60;
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
export function buildUsageDetails(
  snapshot: UsageSnapshot,
  provider: string | undefined,
): string[] {
  const lines = [
    `provider: ${provider || "unknown"}`,
    `plan: ${snapshot.planType || "unknown"}`,
  ];

  lines.push(`email: ${snapshot.email || "unknown"}`);
  lines.push(`5-hour: ${formatWindow(snapshot.fiveHour)}`);
  lines.push(`weekly: ${formatWindow(snapshot.weekly)}`);
  lines.push(`fetched: ${formatDateTime(snapshot.fetchedAt)}`);
  lines.push(`endpoint: ${CHATGPT_BASE_URL}/wham/usage`);
  return lines;
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
