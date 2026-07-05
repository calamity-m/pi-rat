import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Minimal context needed to load project-aware formatter config. */
export interface AutoformatterConfigContext {
  /** Current Pi working directory. */
  cwd: string;
  /** Return whether project-local trust is active when available from the installed Pi version. */
  isProjectTrusted?: () => boolean;
}

/** Supported cwd selector for formatter commands. */
export type FormatterCwd = "project" | string;

/** One configured formatter command. */
export interface FormatterRule {
  /** Stable rule id used for diagnostics and language-less project overrides. */
  id: string;
  /** Language labels used as override keys. */
  languages?: string[];
  /** File extensions matched by this rule, including the leading dot. */
  extensions: string[];
  /** Executable to spawn without a shell. */
  command: string;
  /** Command argv, with `{file}` replaced by the absolute target path. */
  args: string[];
  /** Working directory selector: `project` or an absolute path. */
  cwd: FormatterCwd;
  /** Formatter timeout in milliseconds. */
  timeoutMs: number;
  /** Config source used for diagnostics. */
  source: "global" | "project";
}

/** Parsed autoformatter config plus warnings. */
export interface AutoformatterConfig {
  /** Valid formatter rules. */
  rules: FormatterRule[];
  /** Non-fatal config warnings to surface with tool results. */
  warnings: string[];
}

/** Effective formatter config for a tool result. */
export interface EffectiveFormatterConfig extends AutoformatterConfig {
  /** Whether a project settings file was ignored because it was untrusted or out of scope. */
  projectIgnored?: string;
}

/** Return the absolute global settings path used by autoformatter. */
export function globalAutoformatterSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

/** Return the absolute project settings path used by autoformatter. */
export function projectAutoformatterSettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

/** Return whether a path is inside or equal to a root directory. */
export function isPathUnderRoot(filePath: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(filePath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve a tool input path against the current project cwd. */
export function resolveToolPath(inputPath: string, cwd: string): string {
  return resolve(cwd, inputPath);
}

/** Load and merge global plus trusted project autoformatter settings for one target file. */
export async function loadEffectiveAutoformatterConfig(
  ctx: AutoformatterConfigContext,
  targetPath: string,
  disabledSettingsPaths: ReadonlySet<string>,
): Promise<EffectiveFormatterConfig> {
  const globalPath = globalAutoformatterSettingsPath();
  const projectPath = projectAutoformatterSettingsPath(ctx.cwd);
  const warnings: string[] = [];

  const globalConfig = disabledSettingsPaths.has(globalPath)
    ? disabledConfig("global", globalPath)
    : await loadAutoformatterConfigFile(globalPath, "global");
  warnings.push(...globalConfig.warnings);

  let projectConfig: AutoformatterConfig = { rules: [], warnings: [] };
  let projectIgnored: string | undefined;
  if (!isPathUnderRoot(targetPath, ctx.cwd)) {
    projectIgnored = "project autoformatter config ignored for file outside current project";
  } else if (!ctx.isProjectTrusted?.()) {
    projectIgnored = "project autoformatter config ignored because the project is not trusted";
  } else if (disabledSettingsPaths.has(projectPath)) {
    projectConfig = disabledConfig("project", projectPath);
  } else {
    projectConfig = await loadAutoformatterConfigFile(projectPath, "project");
  }
  warnings.push(...projectConfig.warnings);
  if (projectIgnored) warnings.push(projectIgnored);

  return {
    rules: mergeFormatterRules(globalConfig.rules, projectConfig.rules),
    warnings,
    ...(projectIgnored ? { projectIgnored } : {}),
  };
}

/** Parse a raw autoformatter settings section. */
export function parseAutoformatterSection(
  value: unknown,
  source: "global" | "project",
): AutoformatterConfig {
  if (value === undefined) return { rules: [], warnings: [] };
  if (!isRecord(value))
    return { rules: [], warnings: [`${source} autoformatter must be an object`] };
  const rawRules = value["formatters"];
  if (rawRules === undefined) return { rules: [], warnings: [] };
  if (!Array.isArray(rawRules)) {
    return { rules: [], warnings: [`${source} autoformatter.formatters must be an array`] };
  }
  const rules: FormatterRule[] = [];
  const warnings: string[] = [];
  rawRules.forEach((rawRule, index) => {
    const parsed = parseFormatterRule(rawRule, source);
    if (typeof parsed === "string")
      warnings.push(`${source} autoformatter.formatters[${index}]: ${parsed}`);
    else rules.push(parsed);
  });
  return { rules, warnings };
}

/** Merge global and project rules with language/id override semantics. */
export function mergeFormatterRules(
  globalRules: FormatterRule[],
  projectRules: FormatterRule[],
): FormatterRule[] {
  if (projectRules.length === 0) return [...globalRules];
  const projectLanguages = new Set(projectRules.flatMap((rule) => rule.languages ?? []));
  const languageLessProjectIds = new Set(
    projectRules
      .filter((rule) => !rule.languages || rule.languages.length === 0)
      .map((rule) => rule.id),
  );
  const remainingGlobal: FormatterRule[] = [];
  for (const rule of globalRules) {
    if (!rule.languages || rule.languages.length === 0) {
      if (!languageLessProjectIds.has(rule.id)) remainingGlobal.push(rule);
      continue;
    }
    const remainingLanguages = rule.languages.filter((language) => !projectLanguages.has(language));
    if (remainingLanguages.length === rule.languages.length) remainingGlobal.push(rule);
    else if (remainingLanguages.length > 0)
      remainingGlobal.push({ ...rule, languages: remainingLanguages });
  }
  return [...projectRules, ...remainingGlobal];
}

/** Return the first formatter whose extension list matches the target path. */
export function matchFormatterRule(
  rules: FormatterRule[],
  targetPath: string,
): FormatterRule | undefined {
  return rules.find((rule) => rule.extensions.some((extension) => targetPath.endsWith(extension)));
}

/** Load one settings file's autoformatter section. */
async function loadAutoformatterConfigFile(
  path: string,
  source: "global" | "project",
): Promise<AutoformatterConfig> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parseAutoformatterSection(isRecord(value) ? value["autoformatter"] : undefined, source);
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return { rules: [], warnings: [] };
    return { rules: [], warnings: [`${source} settings autoformatter could not be read`] };
  }
}

/** Build a warning config for settings changed by an agent during this session. */
function disabledConfig(source: "global" | "project", path: string): AutoformatterConfig {
  return {
    rules: [],
    warnings: [
      `${source} autoformatter config ignored until next Pi session because this session changed ${path}`,
    ],
  };
}

/** Parse and validate one formatter rule. */
function parseFormatterRule(value: unknown, source: "global" | "project"): FormatterRule | string {
  if (!isRecord(value)) return "rule must be an object";
  const id = value["id"];
  const command = value["command"];
  if (typeof id !== "string" || id.trim() === "") return "id must be a non-empty string";
  if (typeof command !== "string" || command.trim() === "")
    return "command must be a non-empty string";
  const extensions = parseStringArray(value["extensions"]);
  if (!extensions || extensions.length === 0 || extensions.some((item) => !item.startsWith("."))) {
    return "extensions must be a non-empty array of dot-prefixed strings";
  }
  const languages =
    value["languages"] === undefined ? undefined : parseStringArray(value["languages"]);
  if (value["languages"] !== undefined && !languages)
    return "languages must be an array of non-empty strings";
  const args = value["args"] === undefined ? [] : parseStringArray(value["args"]);
  if (!args) return "args must be an array of strings";
  const cwd = value["cwd"] ?? "project";
  if (cwd !== "project" && (typeof cwd !== "string" || !isAbsolute(cwd))) {
    return 'cwd must be "project" or an absolute path';
  }
  const timeoutMs = value["timeoutMs"] === undefined ? 10000 : value["timeoutMs"];
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return "timeoutMs must be a positive integer";
  }
  return {
    id: id.trim(),
    ...(languages && languages.length > 0 ? { languages } : {}),
    extensions,
    command: command.trim(),
    args,
    cwd,
    timeoutMs,
    source,
  };
}

/** Parse a string array, trimming and dropping empty entries. */
function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return out.length === value.length ? out : undefined;
}

/** Return whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
