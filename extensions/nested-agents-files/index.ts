import { accessSync, constants, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isReadToolResult,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";

const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;
const NESTED_CONTEXT_HEADER = "Nested context files loaded for this path:";

/** Load nested AGENTS.md/CLAUDE.md files when the model reads files below the current cwd. */
export default function nestedAgentsFiles(pi: ExtensionAPI): void {
  const state = new InjectionState();

  pi.on("session_start", (_event, ctx) => {
    state.reset(ctx.cwd);
  });

  pi.on("before_agent_start", (event, ctx) => {
    state.ensureCwd(event.systemPromptOptions.cwd ?? ctx.cwd);
    seedLoadedContextFiles(state, event.systemPromptOptions);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!isReadToolResult(event) || event.isError) return;

    state.ensureCwd(ctx.cwd);

    const readPath = readPathFromInput(event.input);
    if (!readPath) return;

    const targetPath = resolveReadInputPath(ctx.cwd, readPath);
    markExplicitFullContextRead(state, targetPath, event.input);

    const candidatePaths = findApplicableNestedContextFiles(ctx.cwd, targetPath).filter(
      (filePath) => !state.has(filePath),
    );
    const reservedPaths = state.reserve(candidatePaths);
    if (reservedPaths.length === 0) return;

    const loadedFiles = await readContextFiles(reservedPaths, state);
    if (loadedFiles.length === 0) return;

    return {
      content: [
        ...event.content,
        {
          type: "text",
          text: renderNestedContextFiles(ctx.cwd, loadedFiles),
        } satisfies TextContent,
      ],
    };
  });
}

interface LoadedContextFile {
  path: string;
  content: string;
}

class InjectionState {
  private cwd = "";
  private readonly seen = new Set<string>();
  private readonly pending = new Set<string>();

  reset(cwd: string): void {
    this.cwd = path.resolve(cwd);
    this.seen.clear();
    this.pending.clear();
  }

  ensureCwd(cwd: string): void {
    const resolved = path.resolve(cwd);
    if (this.cwd !== resolved) this.reset(resolved);
  }

  has(filePath: string): boolean {
    const key = normalizePath(filePath);
    return this.seen.has(key) || this.pending.has(key);
  }

  markSeen(filePath: string): void {
    this.seen.add(normalizePath(filePath));
  }

  reserve(filePaths: readonly string[]): string[] {
    const reserved: string[] = [];
    for (const filePath of filePaths) {
      const key = normalizePath(filePath);
      if (this.seen.has(key) || this.pending.has(key)) continue;
      this.pending.add(key);
      reserved.push(filePath);
    }
    return reserved;
  }

  markLoaded(filePath: string): void {
    const key = normalizePath(filePath);
    this.pending.delete(key);
    this.seen.add(key);
  }

  release(filePath: string): void {
    this.pending.delete(normalizePath(filePath));
  }
}

function seedLoadedContextFiles(state: InjectionState, options: BuildSystemPromptOptions): void {
  const contextFiles = options.contextFiles ?? [];
  for (const contextFile of contextFiles) state.markSeen(contextFile.path);
}

function readPathFromInput(input: Record<string, unknown>): string | null {
  return typeof input.path === "string" && input.path.length > 0 ? input.path : null;
}

function markExplicitFullContextRead(
  state: InjectionState,
  targetPath: string,
  input: Record<string, unknown>,
): void {
  if (!isContextFileName(path.basename(targetPath))) return;
  if (input.offset != null || input.limit != null) return;
  state.markSeen(targetPath);
}

export function findApplicableNestedContextFiles(cwd: string, targetPath: string): string[] {
  const root = path.resolve(cwd);
  const target = path.resolve(root, targetPath);
  if (!isInsideOrEqual(root, target)) return [];

  const targetDir = path.dirname(target);
  if (targetDir === root) return [];

  const relativeDir = path.relative(root, targetDir);
  if (!relativeDir || relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) return [];

  const results: string[] = [];
  let currentDir = root;
  for (const part of relativeDir.split(path.sep)) {
    currentDir = path.join(currentDir, part);
    const contextFile = findContextFileInDir(currentDir);
    if (contextFile && normalizePath(contextFile) !== normalizePath(target))
      results.push(contextFile);
  }

  return results;
}

function findContextFileInDir(dir: string): string | null {
  for (const filename of CONTEXT_FILE_CANDIDATES) {
    const candidate = path.join(dir, filename);
    if (isReadableFile(candidate)) return candidate;
  }
  return null;
}

export function resolveReadInputPath(cwd: string, rawPath: string): string {
  const expanded = expandReadInputPath(rawPath);
  const resolved = path.resolve(cwd, expanded);
  return firstExistingPath([
    resolved,
    tryMacOSScreenshotPath(resolved),
    resolved.normalize("NFD"),
    tryCurlyQuoteVariant(resolved),
    tryCurlyQuoteVariant(resolved.normalize("NFD")),
  ]);
}

function expandReadInputPath(rawPath: string): string {
  let expanded = normalizeUnicodeSpaces(rawPath);
  if (expanded.startsWith("@")) expanded = expanded.slice(1);
  if (expanded === "~") return homedir();
  if (expanded.startsWith(`~${path.sep}`) || expanded.startsWith("~/"))
    return path.join(homedir(), expanded.slice(2));
  if (expanded.startsWith("file://")) {
    try {
      return fileURLToPath(expanded);
    } catch {
      return expanded;
    }
  }
  return expanded;
}

function firstExistingPath(paths: readonly string[]): string {
  for (const filePath of paths) {
    if (existsSync(filePath)) return filePath;
  }
  return paths[0] ?? "";
}

function isReadableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.R_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function tryMacOSScreenshotPath(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./gi, " $1.");
}

function tryCurlyQuoteVariant(filePath: string): string {
  return filePath.replaceAll("'", "’");
}

function normalizeUnicodeSpaces(value: string): string {
  return value.replace(/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, " ");
}

async function readContextFiles(
  filePaths: readonly string[],
  state: InjectionState,
): Promise<LoadedContextFile[]> {
  const loaded: LoadedContextFile[] = [];
  for (const filePath of filePaths) {
    try {
      const content = await readFile(filePath, "utf8");
      loaded.push({ path: filePath, content });
      state.markLoaded(filePath);
    } catch {
      state.release(filePath);
    }
  }
  return loaded;
}

export function renderNestedContextFiles(cwd: string, files: readonly LoadedContextFile[]): string {
  const renderedFiles = files.map((file) => {
    const displayPath = path.relative(path.resolve(cwd), file.path) || path.basename(file.path);
    return `<context_file path="${escapeXmlAttribute(displayPath)}">\n${file.content}\n</context_file>`;
  });

  return `\n\n${NESTED_CONTEXT_HEADER}\n\n<nested_agents_files>\n${renderedFiles.join("\n\n")}\n</nested_agents_files>`;
}

export function isContextFileName(filename: string): boolean {
  return CONTEXT_FILE_CANDIDATES.includes(filename as (typeof CONTEXT_FILE_CANDIDATES)[number]);
}

function isInsideOrEqual(root: string, maybeChild: string): boolean {
  const relative = path.relative(root, maybeChild);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export const __nestedAgentsFilesForTest = {
  findApplicableNestedContextFiles,
  renderNestedContextFiles,
  resolveReadInputPath,
  isContextFileName,
};
