import type { TextContent } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ToolResultEvent,
  isEditToolResult,
  isWriteToolResult,
} from "@earendil-works/pi-coding-agent";

import {
  globalAutoformatterSettingsPath,
  loadEffectiveAutoformatterConfig,
  matchFormatterRule,
  projectAutoformatterSettingsPath,
  resolveToolPath,
} from "./config.ts";
import { formatterDetails, runFormatterForFile } from "./format.ts";

/** Register the autoformatter extension. */
export default function autoformatterExtension(pi: ExtensionAPI): void {
  const changedSettingsPaths = new Set<string>();
  const reportedFailures = new Set<string>();

  pi.on("tool_result", async (event, ctx) => {
    if (!isSuccessfulFileMutation(event)) return;
    const inputPath = typeof event.input.path === "string" ? event.input.path : undefined;
    if (!inputPath) return;

    const targetPath = resolveToolPath(inputPath, ctx.cwd);
    recordSettingsMutation(targetPath, ctx.cwd, changedSettingsPaths);

    const config = await loadEffectiveAutoformatterConfig(ctx, targetPath, changedSettingsPaths);
    const rule = matchFormatterRule(config.rules, targetPath);
    if (!rule) {
      if (config.warnings.length === 0) return;
      return appendAutoformatterPatch(
        event,
        [`autoformatter: no matching formatter rule`, ...config.warnings],
        {
          warnings: config.warnings,
        },
      );
    }

    const result = await runFormatterForFile(rule, targetPath, ctx.cwd, ctx.signal);
    const warnings = dedupeWarnings([...config.warnings], reportedFailures);
    let detailsResult = result;
    if (!result.ok) {
      const failureKey = `${rule.id}:${result.message}`;
      if (reportedFailures.has(failureKey)) {
        warnings.push(
          `autoformatter ${rule.id} failure repeated; suppressing duplicate detail after first report`,
        );
        detailsResult = { ...result, stdout: undefined, stderr: undefined, outputTruncated: false };
      } else {
        reportedFailures.add(failureKey);
      }
    }

    return appendAutoformatterPatch(
      event,
      [result.message, ...warnings],
      formatterDetails(detailsResult, warnings),
    );
  });
}

/** Return whether a tool result is a successful write or edit result. */
function isSuccessfulFileMutation(event: ToolResultEvent): boolean {
  return !event.isError && (isWriteToolResult(event) || isEditToolResult(event));
}

/** Track agent changes to core settings files so config does not take effect mid-session. */
function recordSettingsMutation(
  targetPath: string,
  cwd: string,
  changedSettingsPaths: Set<string>,
): void {
  if (
    targetPath === globalAutoformatterSettingsPath() ||
    targetPath === projectAutoformatterSettingsPath(cwd)
  ) {
    changedSettingsPaths.add(targetPath);
  }
}

/** Build a tool_result patch that appends formatter notes without changing error status. */
function appendAutoformatterPatch(
  event: ToolResultEvent,
  notes: string[],
  autoformatterDetails: Record<string, unknown>,
): { content: ToolResultEvent["content"]; details: unknown } {
  return {
    content: [
      ...event.content,
      {
        type: "text",
        text: `\n${notes.map((note) => `[autoformatter] ${note}`).join("\n")}`,
      } satisfies TextContent,
    ],
    details: {
      ...(isRecord(event.details) ? event.details : {}),
      autoformatter: autoformatterDetails,
    },
  };
}

/** Deduplicate repeated config warnings during a session. */
function dedupeWarnings(warnings: string[], reportedFailures: Set<string>): string[] {
  const out: string[] = [];
  for (const warning of warnings) {
    const key = `warning:${warning}`;
    if (reportedFailures.has(key)) continue;
    reportedFailures.add(key);
    out.push(warning);
  }
  return out;
}

/** Return whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
