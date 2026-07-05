import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildSubagentPrompt, extractFinalAssistantText, preloadFiles } from "./prompt.ts";
import { formatCancellationResult } from "./store.ts";
import type {
  AppliedPresetInput,
  SubagentModelSelection,
  SubagentRun,
  ToolPolicy,
} from "./types.ts";
import { toolPolicyNames } from "./types.ts";
import type { SubagentStore } from "./store.ts";

export interface RunSubagentOptions {
  runId: string;
  input: AppliedPresetInput;
  selection: SubagentModelSelection;
  policy: ToolPolicy;
  store: SubagentStore;
  ctx: ExtensionContext;
  signal?: AbortSignal;
}

export async function runSubagent(
  options: RunSubagentOptions,
): Promise<{ text: string; cancelled: boolean; run: SubagentRun }> {
  const { runId, input, selection, policy, store, ctx, signal } = options;
  const run = store.get(runId);
  if (!run) throw new Error(`Unknown subagent run: ${runId}`);
  let finalText = "";
  let transcript: unknown[] | undefined;

  const markAborted = (): void => {
    const active = store.get(runId);
    if (!active) return;
    store.update(runId, {
      status: "aborted",
      currentActivity: "aborting",
      endedAt: Date.now(),
    });
  };
  const isCancelled = (): boolean =>
    signal?.aborted === true || store.get(runId)?.status === "aborted";
  const finishCancelled = (): { text: string; cancelled: boolean; run: SubagentRun } => {
    store.finish(runId, finalText.trim(), transcript);
    const finished = store.get(runId) ?? run;
    return { text: formatCancellationResult(finished, finalText), cancelled: true, run: finished };
  };
  const setupAbortListener = (): void => markAborted();

  signal?.addEventListener("abort", setupAbortListener, { once: true });
  try {
    if (signal?.aborted) markAborted();
    if (isCancelled()) return finishCancelled();

    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
    });
    await loader.reload();
    if (isCancelled()) return finishCancelled();

    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      model: selection.model,
      thinkingLevel: selection.thinkingLevel,
      modelRegistry: ctx.modelRegistry,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      tools: toolPolicyNames[policy],
      noTools: policy === "none" ? "all" : undefined,
    });

    if (isCancelled()) {
      await session.abort();
      session.dispose();
      return finishCancelled();
    }

    const unsubscribe = session.subscribe((event) => {
      store.applyEvent(runId, event);
      if (event.type === "agent_end") {
        finalText = extractFinalAssistantText(event.messages);
        transcript = event.messages;
      }
    });

    const abort = (notes?: string): void => {
      const active = store.get(runId);
      if (!active) return;
      store.update(runId, {
        status: "aborted",
        currentActivity: "aborting",
        endedAt: Date.now(),
        cancelNotes: notes ?? active.cancelNotes,
      });
      void session.abort();
    };

    store.setCancel(runId, abort);

    const abortListener = (): void => abort();
    try {
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abortListener, { once: true });
      if (isCancelled()) return finishCancelled();
      const preloadedFiles = await preloadFiles(ctx.cwd, input.files);
      if (isCancelled()) return finishCancelled();
      await session.prompt(buildSubagentPrompt(input, preloadedFiles), { source: "extension" });
    } finally {
      signal?.removeEventListener("abort", abortListener);
      unsubscribe();
      store.setCancel(runId, undefined);
      session.dispose();
    }
  } finally {
    signal?.removeEventListener("abort", setupAbortListener);
  }

  const current = store.get(runId) ?? run;
  const cancelled = current.status === "aborted";
  const text =
    finalText.trim() || (cancelled ? "" : "Subagent completed without a final text response.");
  store.finish(runId, text, transcript);
  const finished = store.get(runId) ?? current;
  return {
    text: cancelled ? formatCancellationResult(finished, text) : text,
    cancelled,
    run: finished,
  };
}
