import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type {
  SettingTier,
  SubagentSettings,
  SubagentSettingsReadResult,
  SubagentTierMapping,
} from "./types.ts";
import { SETTING_TIERS } from "./types.ts";
import { normalizeThinkingLevel, parseCanonicalModelId } from "./model-resolution.ts";

export const SUBAGENT_SETTINGS_PATH = join(getAgentDir(), "settings.json");

export async function readSubagentSettings(): Promise<SubagentSettingsReadResult> {
  try {
    const raw = await readFile(SUBAGENT_SETTINGS_PATH, "utf8");
    return parseSubagentSettings(JSON.parse(raw));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { settings: emptySettings(), warnings: [] };
    if (error instanceof SyntaxError) {
      return {
        settings: emptySettings(),
        warnings: [`Could not parse ${SUBAGENT_SETTINGS_PATH}: ${error.message}`],
      };
    }
    return { settings: emptySettings(), warnings: [formatError(error)] };
  }
}

export async function writeSubagentTier(
  tier: SettingTier,
  mapping: SubagentTierMapping | undefined,
): Promise<void> {
  let root: unknown = {};
  let mode: number | undefined;
  try {
    const raw = await readFile(SUBAGENT_SETTINGS_PATH, "utf8");
    root = JSON.parse(raw);
    mode = (await stat(SUBAGENT_SETTINGS_PATH)).mode & 0o777;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Refusing to overwrite malformed settings file ${SUBAGENT_SETTINGS_PATH}: ${error.message}`,
      );
    }
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  const parsed = parseSubagentSettings(root).settings;
  const next: SubagentSettings = { tiers: { ...parsed.tiers } };
  if (mapping) next.tiers[tier] = mapping;
  else delete next.tiers[tier];
  const merged = mergeSubagentSettings(root, next);

  await mkdir(dirname(SUBAGENT_SETTINGS_PATH), { recursive: true });
  await writeFile(SUBAGENT_SETTINGS_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  if (mode === undefined) await chmod(SUBAGENT_SETTINGS_PATH, 0o600);
}

export function parseSubagentSettings(value: unknown): {
  settings: SubagentSettings;
  warnings: string[];
} {
  const warnings: string[] = [];
  const settings = emptySettings();
  const root = asRecord(value);
  const piRat = asRecord(root?.piRat);
  const subagents = asRecord(piRat?.subagents);
  const tiers = asRecord(subagents?.tiers);
  if (!tiers) return { settings, warnings };

  for (const tier of SETTING_TIERS) {
    const raw = tiers[tier];
    if (raw === undefined) continue;
    const mapping = parseTierMapping(raw, `piRat.subagents.tiers.${tier}`, warnings);
    if (mapping) settings.tiers[tier] = mapping;
  }
  return { settings, warnings };
}

export function mergeSubagentSettings(
  root: unknown,
  settings: SubagentSettings,
): Record<string, unknown> {
  const merged = { ...(asRecord(root) ?? {}) };
  const piRat = { ...(asRecord(merged.piRat) ?? {}) };
  const subagents = { ...(asRecord(piRat.subagents) ?? {}) };
  const tiers: Record<string, unknown> = {};
  for (const tier of SETTING_TIERS) {
    const mapping = settings.tiers[tier];
    if (mapping)
      tiers[tier] = {
        model: mapping.model,
        ...(mapping.thinkingLevel ? { thinkingLevel: mapping.thinkingLevel } : {}),
      };
  }
  subagents.tiers = tiers;
  piRat.subagents = subagents;
  merged.piRat = piRat;
  return merged;
}

function parseTierMapping(
  value: unknown,
  path: string,
  warnings: string[],
): SubagentTierMapping | undefined {
  const record = asRecord(value);
  if (!record) {
    warnings.push(`${path} is ignored because it is not an object.`);
    return undefined;
  }
  if (typeof record.model !== "string") {
    warnings.push(`${path} is ignored because model is missing or not a string.`);
    return undefined;
  }
  try {
    parseCanonicalModelId(record.model);
  } catch (error) {
    warnings.push(`${path} is ignored: ${formatError(error)}`);
    return undefined;
  }
  let thinkingLevel: SubagentTierMapping["thinkingLevel"];
  if (record.thinkingLevel !== undefined) {
    if (typeof record.thinkingLevel !== "string") {
      warnings.push(`${path}.thinkingLevel is ignored because it is not a string.`);
    } else {
      try {
        thinkingLevel = normalizeThinkingLevel(record.thinkingLevel);
      } catch (error) {
        warnings.push(`${path}.thinkingLevel is ignored: ${formatError(error)}`);
      }
    }
  }
  return { model: record.model, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

function emptySettings(): SubagentSettings {
  return { tiers: {} };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && String(error.code) === code;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
