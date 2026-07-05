import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_POLICIES = ["none", "read-only", "coding"] as const;
const PRESET_TIERS = ["default", "fast", "high", "any"] as const;
export const MAX_PRESET_BODY_CHARS = 8_000;

type ToolPolicy = (typeof TOOL_POLICIES)[number];
type PresetTier = (typeof PRESET_TIERS)[number];

/** Markdown-backed preset agent discovered beside the subagents extension module. */
export interface PresetAgent {
  /** Stable preset name, normally derived from the markdown filename. */
  name: string;
  /** Human-facing summary used in tool guidance. */
  description?: string;
  /** Optional model tier default; "any" means parent fallback unless caller overrides. */
  tier?: PresetTier;
  /** Optional tool policy default. */
  tools?: ToolPolicy;
  /** Optional final-answer format guidance. */
  outputFormat?: string;
  /** Markdown body used as the preset role text. */
  body: string;
  /** Filesystem path or URL used for diagnostics. */
  sourcePath: string;
}

/** Result of loading preset agent files, including non-fatal warnings. */
export interface PresetLoadResult {
  /** Valid presets keyed by preset name. */
  presets: Map<string, PresetAgent>;
  /** Non-fatal load warnings for malformed bundled presets. */
  warnings: string[];
}

/** Load and validate preset agents from a module-relative agents directory. */
export function loadPresetAgents(agentsUrl: URL): PresetLoadResult {
  const presets = new Map<string, PresetAgent>();
  const warnings: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(agentsUrl)
      .filter((entry) => extname(entry) === ".md")
      .sort();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT")
      warnings.push(`Skipping preset agents in ${agentsUrl}: ${formatError(error)}`);
    return { presets, warnings };
  }

  for (const entry of entries) {
    const sourcePath = join(fileURLToPath(agentsUrl), entry);
    try {
      const preset = parsePresetAgentFile(entry, readFileSync(sourcePath, "utf8"), sourcePath);
      if (presets.has(preset.name)) {
        warnings.push(
          `Skipping preset agent ${sourcePath}: duplicate preset name "${preset.name}".`,
        );
        continue;
      }
      presets.set(preset.name, preset);
    } catch (error) {
      warnings.push(`Skipping preset agent ${sourcePath}: ${formatError(error)}`);
    }
  }
  return { presets, warnings };
}

/** Parse one markdown preset file and enforce the v1 frontmatter contract. */
export function parsePresetAgentFile(
  filename: string,
  raw: string,
  sourcePath: string,
): PresetAgent {
  const expectedName = basename(filename, ".md");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(expectedName)) {
    throw new Error(
      `invalid preset filename "${filename}"; use lowercase kebab-case markdown names`,
    );
  }
  const { fields, body } = parseFrontmatter(raw);
  const name = fields.name ?? expectedName;
  if (name !== expectedName) {
    throw new Error(
      `frontmatter name "${name}" must match filename-derived name "${expectedName}"`,
    );
  }
  const tier = fields.tier ? parseEnum(fields.tier, PRESET_TIERS, "tier") : undefined;
  const tools = fields.tools ? parseEnum(fields.tools, TOOL_POLICIES, "tools") : undefined;
  if (body.length > MAX_PRESET_BODY_CHARS) {
    throw new Error(`body exceeds ${MAX_PRESET_BODY_CHARS} characters`);
  }
  return {
    name,
    description: fields.description,
    tier,
    tools,
    outputFormat: fields.outputFormat,
    body: body.trim(),
    sourcePath,
  };
}

/** Parse supported frontmatter: simple key: scalar value lines only, no YAML comments. */
function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) return { fields: {}, body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end < 0) throw new Error("frontmatter is not closed with ---");
  const fields: Record<string, string> = {};
  const allowed = new Set(["name", "description", "tier", "tools", "outputFormat"]);
  for (const line of raw.slice(4, end).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) throw new Error("frontmatter comments are not supported");
    const match = /^(\w+):\s*(.*)$/.exec(trimmed);
    if (!match) throw new Error(`unsupported frontmatter structure: ${trimmed}`);
    const [, key, rawValue] = match;
    if (!allowed.has(key)) throw new Error(`unsupported frontmatter key "${key}"`);
    if (Object.hasOwn(fields, key)) throw new Error(`duplicate frontmatter key "${key}"`);
    if (rawValue.includes("#")) throw new Error("frontmatter comments are not supported");
    if (/^[[{]|^[-]/.test(rawValue.trim())) {
      throw new Error(`unsupported scalar value for "${key}"`);
    }
    fields[key] = unquoteScalar(rawValue.trim(), key);
  }
  const bodyStart = raw.slice(end).startsWith("\n---\n") ? end + 5 : end + 4;
  return { fields, body: raw.slice(bodyStart) };
}

/** Return a plain scalar, accepting matching single or double quotes only. */
function unquoteScalar(value: string, key: string): string {
  if (!value) return "";
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && last === first) return value.slice(1, -1);
  if (first === '"' || first === "'" || last === '"' || last === "'") {
    throw new Error(`mismatched quotes for "${key}"`);
  }
  return value;
}

/** Validate a scalar against a string-literal enum. */
function parseEnum<T extends string>(value: string, choices: readonly T[], key: string): T {
  if ((choices as readonly string[]).includes(value)) return value as T;
  throw new Error(`invalid ${key} "${value}"; expected ${choices.join(" | ")}`);
}

/** Format an unknown caught value for skip-and-warn diagnostics. */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
