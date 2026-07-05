import type {
  AgentSessionEvent,
  AppliedPresetInput,
  SubagentModelSelection,
  SubagentRun,
  SubagentStoreListener,
  ToolPolicy,
} from "./types.ts";
import { MAX_RECORDED_RUNS } from "./types.ts";

const NATO_NAMES = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliett",
  "kilo",
  "lima",
  "mike",
  "november",
  "oscar",
  "papa",
  "quebec",
  "romeo",
  "sierra",
  "tango",
  "uniform",
  "victor",
  "whiskey",
  "xray",
  "yankee",
  "zulu",
] as const;

export function nextRunId(seq: number, taken: Iterable<string>): string {
  const base = NATO_NAMES[seq % NATO_NAMES.length];
  const used = new Set(taken);
  let id: string;
  do {
    id = `${base}-${Math.random().toString(36).slice(2, 4)}`;
  } while (used.has(id));
  return id;
}

export function createRun(
  id: string,
  input: AppliedPresetInput,
  selection: SubagentModelSelection,
  tools: ToolPolicy,
): SubagentRun {
  return {
    id,
    task: input.task,
    modelId: selection.modelId,
    thinkingLevel: selection.thinkingLevel,
    modelSource: selection.source,
    modelResolutionWarning: selection.warning,
    tools,
    presetAgentName: input.presetAgentName,
    presetAgentSource: input.presetAgentSource,
    status: "queued",
    currentActivity: "queued",
    startedAt: Date.now(),
  };
}

export function handleSubagentEvent(run: SubagentRun, event: AgentSessionEvent): void {
  switch (event.type) {
    case "agent_start":
      run.status = "running";
      run.currentActivity = "starting";
      break;
    case "turn_start":
      run.currentActivity = "thinking";
      break;
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") run.currentActivity = "responding";
      break;
    case "tool_execution_start":
      run.currentActivity = `using ${event.toolName}`;
      break;
    case "tool_execution_end":
      run.currentActivity = `${event.toolName} ${event.isError ? "error" : "done"}`;
      break;
    case "agent_end":
      if (run.status === "aborted") break;
      if ("willRetry" in event && event.willRetry) {
        run.status = "running";
        run.currentActivity = "retrying";
        break;
      }
      run.status = "done";
      run.currentActivity = "done";
      run.endedAt = Date.now();
      break;
  }
}

export function pruneRuns(runs: SubagentRun[]): void {
  if (runs.length > MAX_RECORDED_RUNS) runs.splice(MAX_RECORDED_RUNS);
}

export function hasActiveRuns(runs: readonly SubagentRun[]): boolean {
  return runs.some((run) => run.status === "queued" || run.status === "running");
}

export function statusIcon(status: SubagentRun["status"]): string {
  if (status === "queued") return "○";
  if (status === "running") return "●";
  if (status === "done") return "✓";
  if (status === "aborted") return "■";
  return "!";
}

export function formatElapsed(run: SubagentRun): string {
  const end = run.endedAt ?? Date.now();
  return `${Math.max(0, Math.round((end - run.startedAt) / 1000))}s`;
}

export function formatRunSource(run: SubagentRun): string {
  return run.presetAgentName
    ? `${run.modelSource} · agent:${run.presetAgentName}`
    : run.modelSource;
}

export function formatCancellationResult(run: SubagentRun, partial: string): string {
  const lines = [`Subagent ${run.id} was cancelled by the user before completing.`];
  if (run.cancelNotes) lines.push(`User notes: ${run.cancelNotes}`);
  const trimmed = partial.trim();
  if (trimmed) lines.push("", "Partial output before cancellation:", trimmed);
  return lines.join("\n");
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 1))}…` : oneLine;
}

function updateLiveTranscript(run: SubagentRun, event: AgentSessionEvent): void {
  if (event.type === "agent_end") {
    run.transcript = event.messages;
    return;
  }
  if (
    event.type !== "message_start" &&
    event.type !== "message_update" &&
    event.type !== "message_end"
  )
    return;
  const message = event.message;
  const messages = [...(run.transcript ?? [])];
  const key = messageKey(message);
  const index = messages.findIndex((candidate) => messageKey(candidate) === key);
  if (index >= 0) messages[index] = message;
  else messages.push(message);
  run.transcript = messages;
}

function messageKey(message: unknown): string {
  const record =
    Boolean(message) && typeof message === "object" ? (message as Record<string, unknown>) : {};
  const role = typeof record.role === "string" ? record.role : "unknown";
  if (role === "toolResult" && typeof record.toolCallId === "string")
    return `tool:${record.toolCallId}`;
  const timestamp = typeof record.timestamp === "number" ? record.timestamp : 0;
  const provider = typeof record.provider === "string" ? record.provider : "";
  const model = typeof record.model === "string" ? record.model : "";
  return `${role}:${timestamp}:${provider}:${model}`;
}

export class SubagentStore {
  private runs: SubagentRun[] = [];
  private listeners = new Set<SubagentStoreListener>();
  private spawnCount = 0;

  list(): readonly SubagentRun[] {
    return this.runs;
  }

  get(id: string): SubagentRun | undefined {
    return this.runs.find((run) => run.id === id);
  }

  hasActiveRuns(): boolean {
    return hasActiveRuns(this.runs);
  }

  create(
    input: AppliedPresetInput,
    selection: SubagentModelSelection,
    tools: ToolPolicy,
  ): SubagentRun {
    const run = createRun(
      nextRunId(
        this.spawnCount++,
        this.runs.map((existing) => existing.id),
      ),
      input,
      selection,
      tools,
    );
    this.runs.unshift(run);
    pruneRuns(this.runs);
    this.emit();
    return run;
  }

  update(id: string, patch: Partial<SubagentRun>): void {
    const run = this.get(id);
    if (!run) return;
    Object.assign(run, patch);
    this.emit();
  }

  applyEvent(id: string, event: AgentSessionEvent): void {
    const run = this.get(id);
    if (!run) return;
    run.events = [...(run.events ?? []), event];
    updateLiveTranscript(run, event);
    handleSubagentEvent(run, event);
    this.emit();
  }

  finish(id: string, finalText: string, transcript: unknown[] | undefined): void {
    const run = this.get(id);
    if (!run) return;
    run.status = run.status === "aborted" ? "aborted" : "done";
    run.currentActivity = run.status;
    run.finalText = finalText;
    run.transcript = transcript;
    run.endedAt = Date.now();
    run.cancel = undefined;
    this.emit();
  }

  setCancel(id: string, cancel: ((notes?: string) => void) | undefined): void {
    const run = this.get(id);
    if (!run) return;
    run.cancel = cancel;
    this.emit();
  }

  abort(id: string, notes?: string): void {
    const run = this.get(id);
    if (!run || (run.status !== "queued" && run.status !== "running")) return;
    if (notes) run.cancelNotes = notes;
    run.status = "aborted";
    run.currentActivity = "aborting";
    run.endedAt = Date.now();
    const cancel = run.cancel;
    run.cancel = undefined;
    this.emit();
    cancel?.(notes);
  }

  fail(id: string, message: string): void {
    const run = this.get(id);
    if (!run) return;
    run.status = "error";
    run.currentActivity = "error";
    run.error = message;
    run.endedAt = Date.now();
    run.cancel = undefined;
    this.emit();
  }

  subscribe(listener: SubagentStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
