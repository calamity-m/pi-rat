import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

import {
  formatCanonicalModelId,
  normalizeThinkingLevel,
  parseCanonicalModelId,
  resolveSubagentModel,
  resolveSubagentModelCore,
} from "./model-resolution.ts";
import {
  applyPresetAgent,
  buildSubagentPrompt,
  formatPresetGuidance,
  preloadFiles,
} from "./prompt.ts";
import { loadPresetAgents, MAX_PRESET_BODY_CHARS, parsePresetAgentFile } from "./preset-agents.ts";
import { runSubagent } from "./runner.ts";
import { parseSubagentSettings, mergeSubagentSettings } from "./settings.ts";
import { formatCancellationResult, nextRunId, SubagentStore } from "./store.ts";
import { showSubagentsCommand, updateSubagentsWidget } from "./ui.ts";
import {
  spawnSubagentSchema,
  type RegisterSubagentsOptions,
  type SpawnSubagentInput,
  type SubagentsController,
} from "./types.ts";

export type { SubagentsController };

/** Register standalone subagent spawning and the /subagents dashboard. */
export function registerSubagents(
  pi: ExtensionAPI,
  options: RegisterSubagentsOptions = {},
): SubagentsController {
  const { presets, warnings } = loadPresetAgents(new URL("./agents/", import.meta.url));
  for (const warning of warnings) console.warn(warning);
  const presetGuidance = formatPresetGuidance(presets);
  const store = new SubagentStore();
  const timerRef: { timer?: ReturnType<typeof setTimeout> } = {};
  let lastCtx: ExtensionContext | undefined;

  store.subscribe(() => {
    if (lastCtx?.mode === "tui") updateSubagentsWidget(lastCtx, store, timerRef);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (timerRef.timer) clearTimeout(timerRef.timer);
    ctx.ui.setStatus("subagents", undefined);
    ctx.ui.setWidget("subagents", undefined);
  });

  pi.registerCommand("subagents", {
    description: "Show active and recent isolated subagent runs",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      await showSubagentsCommand(ctx, store, presets);
    },
  });

  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description: `Run an isolated ephemeral Pi subagent and return only its final answer.${presetGuidance}`,
    promptSnippet:
      "Run an isolated subagent for review, investigation, or parallel analysis tasks. Use a named preset agent when it fits, or omit agent for a custom role/context.",
    promptGuidelines: [
      "Use spawn_subagent for isolated investigation, review, or parallel analysis; prefer preset agent names or tier over raw model unless the user asks for a specific model.",
      "spawn_subagent defaults to read-only tools; request coding tools only when file mutation is explicitly needed.",
      "Named preset agents provide default role text, tier/tools/output format, and explicit tool-call parameters override those defaults.",
      "spawn_subagent returns only the final subagent answer; the nested transcript is intentionally ephemeral.",
    ],
    parameters: spawnSubagentSchema as TSchema,
    async execute(
      _toolCallId,
      params: SpawnSubagentInput,
      signal,
      onUpdate: AgentToolUpdateCallback | undefined,
      ctx,
    ) {
      lastCtx = ctx;
      let runId: string | undefined;
      try {
        const mergedParams = applyPresetAgent(params, presets);
        await options.proxy?.ensure(ctx);
        const selection = await resolveSubagentModel(mergedParams, ctx, pi);
        const policy = mergedParams.tools ?? "read-only";
        const run = store.create(mergedParams, selection, policy);
        runId = run.id;

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Starting subagent ${run.id}${run.presetAgentName ? ` (${run.presetAgentName})` : ""} (${selection.source}, ${policy} tools)…`,
            },
          ],
          details: {
            id: run.id,
            model: selection.modelId,
            thinkingLevel: selection.thinkingLevel,
            tools: policy,
            agent: run.presetAgentName,
            agentSource: run.presetAgentSource,
            warning: selection.warning,
          },
        });

        const result = await runSubagent({
          runId: run.id,
          input: mergedParams,
          selection,
          policy,
          store,
          ctx,
          signal,
        });
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            id: result.run.id,
            model: selection.modelId,
            thinkingLevel: selection.thinkingLevel,
            tools: policy,
            agent: result.run.presetAgentName,
            agentSource: result.run.presetAgentSource,
            cancelled: result.cancelled,
            cancelNotes: result.run.cancelNotes,
            warning: selection.warning,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const run = runId ? store.get(runId) : undefined;
        const cancelled = run?.status === "aborted" || signal?.aborted === true;
        if (runId && !cancelled) store.fail(runId, message);
        if (cancelled && run) {
          return {
            content: [{ type: "text", text: formatCancellationResult(run, run.finalText ?? "") }],
            details: { id: run.id, cancelled: true, cancelNotes: run.cancelNotes },
          };
        }
        return {
          content: [{ type: "text", text: message }],
          details: { id: runId, error: message },
          isError: true,
        };
      }
    },
  });

  return {
    statusLabel: () =>
      store.hasActiveRuns()
        ? `${store.list().filter((run) => run.status === "queued" || run.status === "running").length} subagent(s) running`
        : undefined,
  };
}

export default function subagentsExtension(pi: ExtensionAPI): void {
  registerSubagents(pi);
}

/** Expose pure helpers for focused tests. */
export const __subagentsForTest = {
  parseCanonicalModelId,
  formatCanonicalModelId,
  normalizeThinkingLevel,
  buildSubagentPrompt,
  preloadFiles,
  resolveSubagentModel,
  resolveSubagentModelCore,
  loadPresetAgents,
  parsePresetAgentFile,
  applyPresetAgent,
  formatCancellationResult,
  nextRunId,
  parseSubagentSettings,
  mergeSubagentSettings,
  MAX_PRESET_BODY_CHARS,
} satisfies Record<string, unknown>;
