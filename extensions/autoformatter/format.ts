import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import type { FormatterRule } from "./config.ts";

/** Maximum formatter output stored in tool result details. */
export const FORMATTER_OUTPUT_LIMIT = 4000;

/** Result of one formatter process run. */
export interface FormatterRunResult {
  /** Formatter rule id. */
  ruleId: string;
  /** Whether the formatter exited successfully. */
  ok: boolean;
  /** Human-readable status line. */
  message: string;
  /** Process exit code when available. */
  exitCode?: number | null;
  /** Captured stdout, capped for context safety. */
  stdout?: string;
  /** Captured stderr, capped for context safety. */
  stderr?: string;
  /** Whether output was truncated. */
  outputTruncated?: boolean;
}

const pendingByFile = new Map<string, Promise<FormatterRunResult>>();

/** Run a formatter command under Pi's per-file mutation queue and coalesce same-file pending runs. */
export async function runFormatterForFile(
  rule: FormatterRule,
  filePath: string,
  projectCwd: string,
  signal?: AbortSignal,
): Promise<FormatterRunResult> {
  const existing = pendingByFile.get(filePath);
  if (existing) {
    const result = await existing;
    return { ...result, message: `${result.message} (coalesced with pending formatter run)` };
  }
  const run = withFileMutationQueue(filePath, () =>
    runFormatterProcess(rule, filePath, projectCwd, signal),
  );
  pendingByFile.set(filePath, run);
  try {
    return await run;
  } finally {
    if (pendingByFile.get(filePath) === run) pendingByFile.delete(filePath);
  }
}

/** Run one formatter process directly without a shell. */
export async function runFormatterProcess(
  rule: FormatterRule,
  filePath: string,
  projectCwd: string,
  signal?: AbortSignal,
): Promise<FormatterRunResult> {
  const cwd = rule.cwd === "project" ? projectCwd : rule.cwd;
  const absoluteCwd = resolve(cwd);
  try {
    await access(absoluteCwd);
  } catch {
    return {
      ruleId: rule.id,
      ok: false,
      message: `autoformatter ${rule.id} skipped: cwd does not exist (${absoluteCwd})`,
    };
  }

  const args = rule.args.map((arg) => (arg === "{file}" ? filePath : arg));
  return await new Promise<FormatterRunResult>((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(rule.command, args, {
      cwd: absoluteCwd,
      shell: false,
      windowsHide: true,
      signal,
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000);
    }, rule.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const next = appendCapped(stdout, String(chunk));
      stdout = next.text;
      outputTruncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk) => {
      const next = appendCapped(stderr, String(chunk));
      stderr = next.text;
      outputTruncated ||= next.truncated;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolveResult({
        ruleId: rule.id,
        ok: false,
        message: `autoformatter ${rule.id} failed to start: ${error.message}`,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
        outputTruncated,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolveResult({
        ruleId: rule.id,
        ok: !timedOut && code === 0,
        message: timedOut
          ? `autoformatter ${rule.id} timed out after ${rule.timeoutMs}ms`
          : code === 0
            ? `autoformatter ${rule.id} succeeded`
            : `autoformatter ${rule.id} failed with exit code ${code}`,
        exitCode: code,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
        outputTruncated,
      });
    });
  });
}

/** Convert formatter result into details object for tool result patches. */
export function formatterDetails(
  result: FormatterRunResult,
  warnings: string[],
): Record<string, unknown> {
  return {
    ruleId: result.ruleId,
    ok: result.ok,
    message: result.message,
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}),
    ...(result.outputTruncated ? { outputTruncated: true } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Append text while preserving at most FORMATTER_OUTPUT_LIMIT characters. */
function appendCapped(current: string, chunk: string): { text: string; truncated: boolean } {
  const combined = current + chunk;
  if (combined.length <= FORMATTER_OUTPUT_LIMIT) return { text: combined, truncated: false };
  return { text: combined.slice(0, FORMATTER_OUTPUT_LIMIT), truncated: true };
}
