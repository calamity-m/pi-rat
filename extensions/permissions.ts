import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import type { Component } from "@earendil-works/pi-tui";

import type { NestedPickerContent, NestedPickerRow } from "./lib/nested-picker-panel.ts";

const PERMISSIONS_SETTINGS_KEY = "permissions";
const APPROVE = "Approve";
const APPROVE_FOR_SESSION = "Approve for session";
const DENY = "Deny";
const MAX_SUMMARY_LENGTH = 220;
const MAX_CANONICAL_PREVIEW = 500;

const DEFAULT_PERMISSION_RULES: readonly WritablePermissionRule[] = [
  { tool: "bash", match: "\\bdocker\\b", action: "prompt" },
  { tool: "bash", match: "\\bcurl\\b", action: "prompt" },
  { tool: "bash", match: "\\bkubectl\\b", action: "prompt" },
  { tool: "bash", match: "python\\s+-c", action: "prompt" },
  { tool: "read", match: "\\.env", action: "prompt" },
  { tool: "edit", match: "\\.env", action: "prompt" },
];

type PermissionAction = "prompt" | "deny";

interface WritablePermissionRule {
  tool: string;
  match: string;
  action: PermissionAction;
}

interface PermissionSettings {
  rules?: unknown;
}

export interface PermissionRule {
  index: number;
  tool: string;
  match: string;
  action: PermissionAction;
  regex: RegExp;
}

export interface InvalidPermissionRule {
  index?: number;
  reason: string;
  raw?: string;
}

export interface PermissionPolicy {
  settingsPath: string;
  loaded: boolean;
  policyPresent: boolean;
  validRules: PermissionRule[];
  invalidRules: InvalidPermissionRule[];
  loadError?: string;
}

export interface SessionApproval {
  key: string;
  toolName: string;
  canonicalInput: string;
  summary: string;
  approvedAt: string;
}

interface PermissionDecision {
  rule: PermissionRule;
}

interface InitPermissionsResult {
  ok: boolean;
  settingsPath: string;
  added: number;
  skipped: number;
  error?: string;
}

interface InitPermissionsSettingsResult {
  ok: boolean;
  added: number;
  skipped: number;
  content?: string;
  error?: string;
}

interface PermissionsRowValue {
  kind:
    | "status"
    | "rules-category"
    | "rules-tool"
    | "approvals-category"
    | "approvals-tool"
    | "init"
    | "empty";
  toolName?: string;
  message?: string;
}

/** Personal permissions gate for Pi tool calls. */
export default function permissionsExtension(pi: ExtensionAPI): void {
  const approvals = new SessionApprovalStore();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("permissions", "permissions loaded");
  });

  pi.on("tool_call", async (event, ctx) => enforceToolPermission(event, ctx, approvals));

  pi.registerCommand("permissions", {
    description: "Inspect permissions policy and session approvals",
    handler: async (_args, ctx) => {
      const policy = await loadGlobalPermissionPolicy();
      if (ctx.mode === "tui") {
        await showPermissionsPicker(ctx, policy, approvals.list());
        return;
      }

      showPermissionsFallback(ctx, policy, approvals.list());
    },
  });
}

async function enforceToolPermission(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  approvals: SessionApprovalStore,
): Promise<ToolCallEventResult | void> {
  const canonicalInput = canonicalJson(event.input);
  const policy = await loadGlobalPermissionPolicy();
  const decision = evaluateToolCall(policy.validRules, event.toolName, canonicalInput);
  if (!decision) return;

  const summary = summarizeToolCall(event.toolName, event.input, canonicalInput);
  if (decision.rule.action === "deny") {
    return block(`Permission denied by rule #${displayRuleNumber(decision.rule)}: ${summary}`);
  }

  const approvalKey = buildApprovalKey(event.toolName, canonicalInput);
  if (approvals.has(approvalKey)) return;

  if (!ctx.hasUI) {
    return block(`Permission approval required but no interactive UI is available: ${summary}`);
  }

  const choice = await ctx.ui.select(
    buildApprovalPrompt(event.toolName, summary, decision.rule),
    [APPROVE, APPROVE_FOR_SESSION, DENY],
    { signal: ctx.signal },
  );

  if (choice === APPROVE) return;
  if (choice === APPROVE_FOR_SESSION) {
    approvals.add({
      key: approvalKey,
      toolName: event.toolName,
      canonicalInput,
      summary,
      approvedAt: new Date().toISOString(),
    });
    return;
  }

  return block(`Permission prompt denied for ${event.toolName}: ${summary}`);
}

async function showPermissionsPicker(
  ctx: ExtensionCommandContext,
  policy: PermissionPolicy,
  approvals: readonly SessionApproval[],
): Promise<void> {
  const { NestedPickerPanel } = await import("./lib/nested-picker-panel.ts");
  const rows = buildPermissionsRows(policy, approvals);

  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    return new NestedPickerPanel<PermissionsRowValue>({
      title: "permissions",
      rows,
      visibleRows: 8,
      theme,
      keybindings,
      requestRender: () => tui.requestRender(),
      onCancel: () => done(),
      renderContent: ({ row }) => renderPermissionsContent(row, policy, approvals, () => tui.requestRender()),
    });
  });
}

function showPermissionsFallback(
  ctx: ExtensionCommandContext,
  policy: PermissionPolicy,
  approvals: readonly SessionApproval[],
): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(buildPermissionsStatusLines(policy, approvals).join("\n"), "info");
}

async function loadGlobalPermissionPolicy(): Promise<PermissionPolicy> {
  const settingsPath = getGlobalSettingsPath();
  try {
    const raw = await readFile(settingsPath, "utf8");
    return parsePermissionsSettings(raw, settingsPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyPolicy(settingsPath, false, "settings file not found");
    }
    return emptyPolicy(settingsPath, false, errorMessage(error));
  }
}

function getGlobalSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

async function initDefaultPermissions(settingsPath = getGlobalSettingsPath()): Promise<InitPermissionsResult> {
  let raw: string | undefined;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      return { ok: false, settingsPath, added: 0, skipped: 0, error: errorMessage(error) };
    }
  }

  const result = buildDefaultPermissionsSettings(raw);
  if (!result.ok) {
    return {
      ok: false,
      settingsPath,
      added: result.added,
      skipped: result.skipped,
      error: result.error,
    };
  }

  if (result.content !== undefined) {
    try {
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, result.content, "utf8");
    } catch (error) {
      return {
        ok: false,
        settingsPath,
        added: result.added,
        skipped: result.skipped,
        error: errorMessage(error),
      };
    }
  }

  return { ok: true, settingsPath, added: result.added, skipped: result.skipped };
}

function buildDefaultPermissionsSettings(raw: string | undefined): InitPermissionsSettingsResult {
  let settings: Record<string, unknown>;
  if (raw === undefined) {
    settings = {};
  } else {
    try {
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return { ok: false, added: 0, skipped: 0, error: "settings root must be an object" };
      }
      settings = parsed;
    } catch (error) {
      return { ok: false, added: 0, skipped: 0, error: `invalid JSON: ${errorMessage(error)}` };
    }
  }

  const permissions = settings[PERMISSIONS_SETTINGS_KEY];
  const nextPermissions: Record<string, unknown> = permissions === undefined ? {} : { ...asRecord(permissions) };
  if (permissions !== undefined && !isRecord(permissions)) {
    return { ok: false, added: 0, skipped: 0, error: "permissions must be an object" };
  }

  const existingRules = nextPermissions.rules;
  if (existingRules !== undefined && !Array.isArray(existingRules)) {
    return { ok: false, added: 0, skipped: 0, error: "permissions.rules must be an array" };
  }

  const rules = existingRules === undefined ? [] : [...existingRules];
  const toAdd = DEFAULT_PERMISSION_RULES.filter((rule) => !rules.some((existing) => sameRule(existing, rule)));
  nextPermissions.rules = [...rules, ...toAdd];
  settings[PERMISSIONS_SETTINGS_KEY] = nextPermissions;

  return {
    ok: true,
    added: toAdd.length,
    skipped: DEFAULT_PERMISSION_RULES.length - toAdd.length,
    content: toAdd.length > 0 ? `${JSON.stringify(settings, null, 2)}\n` : undefined,
  };
}

function sameRule(existing: unknown, expected: WritablePermissionRule): boolean {
  return (
    isRecord(existing) &&
    existing.tool === expected.tool &&
    existing.match === expected.match &&
    existing.action === expected.action
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parsePermissionsSettings(raw: string, settingsPath = getGlobalSettingsPath()): PermissionPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return emptyPolicy(settingsPath, false, `invalid JSON: ${errorMessage(error)}`);
  }

  if (!isRecord(parsed)) {
    return emptyPolicy(settingsPath, true, "settings root must be an object");
  }

  const permissions = parsed[PERMISSIONS_SETTINGS_KEY];
  if (permissions === undefined) {
    return {
      settingsPath,
      loaded: true,
      policyPresent: false,
      validRules: [],
      invalidRules: [],
    };
  }
  if (!isRecord(permissions)) {
    return emptyPolicy(settingsPath, true, "permissions must be an object", true);
  }

  return parsePermissionConfig(permissions, settingsPath);
}

function parsePermissionConfig(config: PermissionSettings, settingsPath = getGlobalSettingsPath()): PermissionPolicy {
  const validRules: PermissionRule[] = [];
  const invalidRules: InvalidPermissionRule[] = [];
  if (config.rules === undefined) {
    return { settingsPath, loaded: true, policyPresent: true, validRules, invalidRules };
  }
  if (!Array.isArray(config.rules)) {
    return {
      settingsPath,
      loaded: true,
      policyPresent: true,
      validRules,
      invalidRules: [{ reason: "permissions.rules must be an array", raw: summarizeRaw(config.rules) }],
    };
  }

  config.rules.forEach((rawRule, index) => {
    const parsed = parsePermissionRule(rawRule, index);
    if ("rule" in parsed) validRules.push(parsed.rule);
    else invalidRules.push(parsed.invalid);
  });

  return { settingsPath, loaded: true, policyPresent: true, validRules, invalidRules };
}

function parsePermissionRule(
  rawRule: unknown,
  index: number,
): { rule: PermissionRule } | { invalid: InvalidPermissionRule } {
  const raw = summarizeRaw(rawRule);
  if (!isRecord(rawRule)) {
    return { invalid: { index, reason: "rule must be an object", raw } };
  }

  const tool = rawRule.tool;
  if (typeof tool !== "string" || tool.trim() === "") {
    return { invalid: { index, reason: "rule.tool must be a non-empty string", raw } };
  }

  const match = rawRule.match;
  if (typeof match !== "string") {
    return { invalid: { index, reason: "rule.match must be a string", raw } };
  }

  const action = rawRule.action;
  if (action !== "prompt" && action !== "deny") {
    return { invalid: { index, reason: 'rule.action must be "prompt" or "deny"', raw } };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(match);
  } catch (error) {
    return { invalid: { index, reason: `invalid rule.match regex: ${errorMessage(error)}`, raw } };
  }

  return { rule: { index, tool, match, action, regex } };
}

function emptyPolicy(
  settingsPath: string,
  loaded: boolean,
  loadError?: string,
  policyPresent = false,
): PermissionPolicy {
  return {
    settingsPath,
    loaded,
    policyPresent,
    validRules: [],
    invalidRules: loadError ? [{ reason: loadError }] : [],
    loadError,
  };
}

function evaluateToolCall(
  rules: readonly PermissionRule[],
  toolName: string,
  canonicalInput: string,
): PermissionDecision | undefined {
  const rule = rules.find(
    (candidate) =>
      (candidate.tool === "*" || candidate.tool === toolName) && candidate.regex.test(canonicalInput),
  );
  return rule ? { rule } : undefined;
}

function canonicalJson(value: unknown): string {
  const normalized = normalizeForJson(value, new WeakSet<object>());
  const rendered = JSON.stringify(normalized);
  return rendered ?? String(normalized);
}

function normalizeForJson(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((entry) => normalizeForJson(entry, seen));

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
    out[key] = normalizeForJson(entry, seen);
  }
  return out;
}

function buildApprovalKey(toolName: string, canonicalInput: string): string {
  return `${toolName}\u0000${canonicalInput}`;
}

function buildApprovalPrompt(toolName: string, summary: string, rule: PermissionRule): string {
  return [
    `Approve ${toolName} tool call?`,
    summary,
    `Rule #${displayRuleNumber(rule)}: ${formatRuleBrief(rule)}`,
  ].join("\n");
}

function summarizeToolCall(toolName: string, input: unknown, canonicalInput = canonicalJson(input)): string {
  const data = isRecord(input) ? input : {};
  switch (toolName) {
    case "bash":
      return truncate(`command: ${stringValue(data.command)}`, MAX_SUMMARY_LENGTH);
    case "read":
      return truncate(`path: ${stringValue(data.path)}${rangeSuffix(data)}`, MAX_SUMMARY_LENGTH);
    case "write":
      return truncate(
        `path: ${stringValue(data.path)} (${contentLength(data.content)} chars)`,
        MAX_SUMMARY_LENGTH,
      );
    case "edit":
      return truncate(
        `path: ${stringValue(data.path)} (${Array.isArray(data.edits) ? data.edits.length : 0} edit(s))`,
        MAX_SUMMARY_LENGTH,
      );
    case "grep":
      return truncate(
        `pattern: ${stringValue(data.pattern)} in ${stringValue(data.path ?? ".")}${data.glob ? ` glob=${String(data.glob)}` : ""}`,
        MAX_SUMMARY_LENGTH,
      );
    case "find":
      return truncate(
        `pattern: ${stringValue(data.pattern)} in ${stringValue(data.path ?? ".")}`,
        MAX_SUMMARY_LENGTH,
      );
    case "ls":
      return truncate(`path: ${stringValue(data.path ?? ".")}`, MAX_SUMMARY_LENGTH);
    default:
      return truncate(canonicalInput, MAX_SUMMARY_LENGTH);
  }
}

function buildPermissionsRows(
  policy: PermissionPolicy,
  approvals: readonly SessionApproval[],
): readonly NestedPickerRow<PermissionsRowValue>[] {
  return [
    {
      id: "status",
      label: "Status",
      description: "Extension and loaded policy summary",
      value: { kind: "status" },
    },
    {
      id: "rules",
      label: "Rules",
      description: `${policy.validRules.length} valid rule(s), ${policy.invalidRules.length} invalid`,
      value: { kind: "rules-category" },
      children: buildRuleToolRows(policy),
    },
    {
      id: "approvals-session",
      label: "Approvals (Session)",
      description: `${approvals.length} current session approval(s)`,
      value: { kind: "approvals-category" },
      children: buildApprovalToolRows(approvals),
    },
    {
      id: "init",
      label: "init",
      description: "Install starter rules, then run /reload",
      value: { kind: "init" },
    },
  ];
}

function buildRuleToolRows(policy: PermissionPolicy): readonly NestedPickerRow<PermissionsRowValue>[] {
  const groups = groupRulesByTool(policy.validRules);
  if (groups.size === 0) {
    return [
      {
        id: "rules-empty",
        label: "No rules",
        description: "No configured valid rules; default allow is active",
        value: { kind: "empty", message: "No configured valid rules. Tool calls default to allow." },
      },
    ];
  }

  return [...groups.entries()].map(([toolName, rules]) => ({
    id: `rules-${rowId(toolName)}`,
    label: displayToolName(toolName),
    description: `${rules.length} rule(s)`,
    value: { kind: "rules-tool", toolName },
  }));
}

function buildApprovalToolRows(
  approvals: readonly SessionApproval[],
): readonly NestedPickerRow<PermissionsRowValue>[] {
  const groups = groupApprovalsByTool(approvals);
  if (groups.size === 0) {
    return [
      {
        id: "approvals-empty",
        label: "No session approvals",
        description: "No tool calls have been approved for this session",
        value: { kind: "empty", message: "No session approvals yet." },
      },
    ];
  }

  return [...groups.entries()].map(([toolName, entries]) => ({
    id: `approvals-${rowId(toolName)}`,
    label: displayToolName(toolName),
    description: `${entries.length} approval(s)`,
    value: { kind: "approvals-tool", toolName },
  }));
}

function renderPermissionsContent(
  row: NestedPickerRow<PermissionsRowValue>,
  policy: PermissionPolicy,
  approvals: readonly SessionApproval[],
  requestRender: () => void = () => {},
): NestedPickerContent {
  const value = row.value;
  if (!value) return ["No details available."];

  switch (value.kind) {
    case "status":
      return buildPermissionsStatusLines(policy, approvals);
    case "rules-tool":
      return formatRulesForTool(value.toolName ?? "", policy.validRules);
    case "approvals-tool":
      return formatApprovalsForTool(value.toolName ?? "", approvals);
    case "init":
      return new InitPermissionsContent(requestRender);
    case "empty":
      return [value.message ?? "Nothing to show."];
    case "rules-category":
      return ["Select a tool to inspect its rules."];
    case "approvals-category":
      return ["Select a tool to inspect session approvals."];
  }
}

function buildPermissionsStatusLines(
  policy: PermissionPolicy,
  approvals: readonly SessionApproval[],
): string[] {
  const lines = [
    "Permissions extension",
    "",
    "extension: alive",
    `settings: ${policy.settingsPath}`,
    `settings loaded: ${policy.loaded ? "yes" : "no"}`,
    `policy: ${policy.policyPresent ? "permissions.rules configured" : "not configured (default allow)"}`,
    `valid rules: ${policy.validRules.length}`,
    `invalid rules: ${policy.invalidRules.length}`,
    `session approvals: ${approvals.length}`,
  ];

  if (policy.loadError) lines.push(`load error: ${policy.loadError}`);
  if (policy.invalidRules.length > 0) {
    lines.push("", "Invalid config entries:");
    for (const invalid of policy.invalidRules) {
      lines.push(`- ${formatInvalidRule(invalid)}`);
    }
  }

  return lines;
}

function formatRulesForTool(toolName: string, rules: readonly PermissionRule[]): string[] {
  const matching = rules.filter((rule) => rule.tool === toolName);
  if (matching.length === 0) return [`No rules for ${displayToolName(toolName)}.`];

  const lines = [`Rules for ${displayToolName(toolName)}`, ""];
  for (const rule of matching) {
    lines.push(
      `#${displayRuleNumber(rule)} ${rule.action.toUpperCase()}`,
      `tool: ${rule.tool}`,
      `match: /${rule.match}/`,
      "",
    );
  }
  lines.pop();
  return lines;
}

function formatApprovalsForTool(
  toolName: string,
  approvals: readonly SessionApproval[],
): string[] {
  const matching = approvals.filter((approval) => approval.toolName === toolName);
  if (matching.length === 0) return [`No session approvals for ${displayToolName(toolName)}.`];

  const lines = [`Session approvals for ${displayToolName(toolName)}`, ""];
  for (const approval of matching) {
    lines.push(
      `approved: ${approval.approvedAt}`,
      `summary: ${approval.summary}`,
      "input:",
      truncate(approval.canonicalInput, MAX_CANONICAL_PREVIEW),
      "",
    );
  }
  lines.pop();
  return lines;
}

function groupRulesByTool(rules: readonly PermissionRule[]): Map<string, PermissionRule[]> {
  const groups = new Map<string, PermissionRule[]>();
  for (const rule of rules) {
    const entries = groups.get(rule.tool) ?? [];
    entries.push(rule);
    groups.set(rule.tool, entries);
  }
  return sortGroupedMap(groups);
}

function groupApprovalsByTool(approvals: readonly SessionApproval[]): Map<string, SessionApproval[]> {
  const groups = new Map<string, SessionApproval[]>();
  for (const approval of approvals) {
    const entries = groups.get(approval.toolName) ?? [];
    entries.push(approval);
    groups.set(approval.toolName, entries);
  }
  return sortGroupedMap(groups);
}

function sortGroupedMap<T>(groups: Map<string, T[]>): Map<string, T[]> {
  return new Map([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

class InitPermissionsContent implements Component {
  private lines = ["Initializing default permissions…"];

  constructor(private readonly requestRender: () => void) {
    void this.init();
  }

  render(): string[] {
    return this.lines;
  }

  invalidate(): void {}

  private async init(): Promise<void> {
    const result = await initDefaultPermissions();
    if (!result.ok) {
      this.lines = [
        "Could not initialize default permissions.",
        `settings: ${result.settingsPath}`,
        `error: ${result.error ?? "unknown error"}`,
      ];
      this.requestRender();
      return;
    }

    this.lines = [
      "Default permissions initialized.",
      `settings: ${result.settingsPath}`,
      `added rules: ${result.added}`,
      `already present: ${result.skipped}`,
      "",
      "Run /reload to reload Pi with the updated permissions.",
    ];
    this.requestRender();
  }
}

class SessionApprovalStore {
  private readonly approvals = new Map<string, SessionApproval>();

  has(key: string): boolean {
    return this.approvals.has(key);
  }

  add(approval: SessionApproval): void {
    this.approvals.set(approval.key, approval);
  }

  list(): readonly SessionApproval[] {
    return [...this.approvals.values()].sort(
      (left, right) =>
        left.toolName.localeCompare(right.toolName) || left.approvedAt.localeCompare(right.approvedAt),
    );
  }
}

function block(reason: string): ToolCallEventResult {
  return { block: true, reason };
}

function formatInvalidRule(invalid: InvalidPermissionRule): string {
  const prefix = invalid.index === undefined ? "settings" : `rule #${invalid.index + 1}`;
  return `${prefix}: ${invalid.reason}${invalid.raw ? ` (${invalid.raw})` : ""}`;
}

function formatRuleBrief(rule: PermissionRule): string {
  return `${rule.action} ${displayToolName(rule.tool)} /${rule.match}/`;
}

function displayRuleNumber(rule: PermissionRule): number {
  return rule.index + 1;
}

function displayToolName(toolName: string): string {
  return toolName === "*" ? "Any tool (*)" : toolName;
}

function rowId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/\*/g, "any")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "unknown"
  );
}

function rangeSuffix(data: Record<string, unknown>): string {
  const parts = [];
  if (typeof data.offset === "number") parts.push(`offset=${data.offset}`);
  if (typeof data.limit === "number") parts.push(`limit=${data.limit}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function contentLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value || "<empty>";
  if (value === undefined) return "<missing>";
  return String(value);
}

function summarizeRaw(value: unknown): string {
  return truncate(canonicalJson(value), MAX_CANONICAL_PREVIEW);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const __permissionsForTest = {
  APPROVE,
  APPROVE_FOR_SESSION,
  DEFAULT_PERMISSION_RULES,
  DENY,
  buildApprovalKey,
  buildDefaultPermissionsSettings,
  buildPermissionsRows,
  buildPermissionsStatusLines,
  canonicalJson,
  evaluateToolCall,
  formatApprovalsForTool,
  formatRulesForTool,
  parsePermissionConfig,
  parsePermissionsSettings,
  renderPermissionsContent,
  summarizeToolCall,
};
