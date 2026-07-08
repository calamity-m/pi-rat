import {
  AssistantMessageComponent,
  getMarkdownTheme,
  UserMessageComponent,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";

import {
  NestedPickerPanel,
  type NestedPickerPanelTheme,
  type NestedPickerRow,
} from "../lib/nested-picker-panel.ts";
import { OverlayPanel, rightOverlayOptions, type OverlayPanelTheme } from "../lib/overlay.ts";
import { currentThinkingBorderColor } from "../lib/thinking-border.ts";
import { compactDisplayedSubagentPrompt } from "./display.ts";
import { formatCanonicalModelId, normalizeThinkingLevel } from "./model-resolution.ts";
import type { PresetAgent } from "./preset-agents.ts";
import { readSubagentSettings, writeSubagentTier } from "./settings.ts";
import type { SettingTier, SubagentRun } from "./types.ts";
import { formatElapsed, formatRunSource, statusIcon, SubagentStore, truncate } from "./store.ts";
import { formatCompactToolSummary } from "./tool-summary.ts";
import { THINKING_LEVELS } from "./types.ts";

interface RowValue {
  kind: "category" | "run" | "preset" | "setting" | "help" | "empty";
  runId?: string;
  preset?: PresetAgent;
  tier?: SettingTier;
}

export function updateSubagentsWidget(
  ctx: ExtensionContext,
  store: SubagentStore,
  timerRef: { timer?: ReturnType<typeof setTimeout> },
): void {
  const runs = store.list();
  const active = runs.filter((run) => run.status === "queued" || run.status === "running");
  if (timerRef.timer) {
    clearTimeout(timerRef.timer);
    timerRef.timer = undefined;
  }
  if (active.length) {
    ctx.ui.setStatus("subagents", `${active.length} subagent(s) running`);
    ctx.ui.setWidget("subagents", buildWidgetLines(runs), { placement: "aboveEditor" });
    return;
  }
  ctx.ui.setStatus("subagents", undefined);
  if (runs.length) {
    ctx.ui.setWidget("subagents", buildWidgetLines(runs.slice(0, 3)), { placement: "aboveEditor" });
    timerRef.timer = setTimeout(() => ctx.ui.setWidget("subagents", undefined), 8_000);
  } else {
    ctx.ui.setWidget("subagents", undefined);
  }
}

export async function showSubagentsCommand(
  ctx: ExtensionCommandContext,
  store: SubagentStore,
  presets: Map<string, PresetAgent>,
): Promise<void> {
  if (ctx.mode === "tui") {
    await showDashboard(ctx, store, presets);
    return;
  }
  if (ctx.hasUI) ctx.ui.notify(buildSubagentsReport(store).join("\n"), "info");
}

export function buildSubagentsReport(store: SubagentStore): string[] {
  const runs = store.list();
  if (!runs.length) return ["subagents", "No subagent runs recorded."];
  return [
    "subagents",
    ...runs.map(
      (run) =>
        `${statusIcon(run.status)} ${run.id} ${run.status} ${formatElapsed(run)} ${truncate(run.task, 72)}`,
    ),
  ];
}

async function showDashboard(
  ctx: ExtensionCommandContext,
  store: SubagentStore,
  presets: Map<string, PresetAgent>,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    const requestRender = () => tui.requestRender();
    const panel = new NestedPickerPanel<RowValue>({
      title: "subagents",
      rootBreadcrumbLabel: "Subagents",
      rows: buildRows(store, presets),
      enableSearch: true,
      visibleRows: 10,
      theme,
      keybindings,
      requestRender,
      borderColor: currentThinkingBorderColor(ctx, theme),
      onCancel: () => done(),
      renderContent: ({ row }) => renderContent(ctx, theme, keybindings, requestRender, store, row),
    });
    const unsubscribe = store.subscribe(() => panel.setRows(buildRows(store, presets)));
    return {
      render: (width: number) => panel.render(width),
      handleInput: (data: string) => panel.handleInput(data),
      invalidate: () => panel.invalidate(),
      dispose: unsubscribe,
    } as Component & { dispose(): void };
  });
}

function buildRows(
  store: SubagentStore,
  presets: Map<string, PresetAgent>,
): readonly NestedPickerRow<RowValue>[] {
  const runs = store.list();
  const active = runs.filter((run) => run.status === "queued" || run.status === "running");
  const recent = runs.filter((run) => run.status !== "queued" && run.status !== "running");
  return [
    {
      id: "runs",
      label: "Runs",
      description: `${active.length} active, ${recent.length} recent`,
      value: { kind: "category" },
      children: [
        {
          id: "active",
          label: "Active",
          value: { kind: "category" },
          children: runRows(active, "active"),
        },
        {
          id: "recent",
          label: "Recent",
          value: { kind: "category" },
          children: runRows(recent, "recent"),
        },
        ...(runs.length
          ? []
          : [
              {
                id: "empty",
                label: "No subagent runs",
                description: "spawn_subagent has not run yet",
                value: { kind: "empty" as const },
              },
            ]),
      ],
    },
    {
      id: "presets",
      label: "Presets",
      description: `${presets.size} bundled preset agents`,
      value: { kind: "category" },
      children: [...presets.values()].map((preset) => ({
        id: `preset-${preset.name}`,
        label: preset.name,
        description: preset.description,
        value: { kind: "preset", preset },
      })),
    },
    {
      id: "settings",
      label: "Settings",
      description: "fast/high tier model mappings",
      value: { kind: "category" },
      children: ["fast", "high"].map((tier) => ({
        id: `settings-${tier}`,
        label: `${tier[0]!.toUpperCase()}${tier.slice(1)} tier`,
        description: "s select model • t thinking • u unset • r reload",
        value: { kind: "setting", tier: tier as SettingTier },
      })),
    },
    {
      id: "help",
      label: "Help",
      description: "Keyboard shortcuts and usage",
      value: { kind: "help" },
    },
  ];
}

function runRows(
  runs: readonly SubagentRun[],
  prefix: string,
): readonly NestedPickerRow<RowValue>[] {
  if (!runs.length) return [{ id: `${prefix}-empty`, label: "No runs", value: { kind: "empty" } }];
  return runs.map((run) => ({
    id: `${prefix}-${run.id}`,
    label: `${statusIcon(run.status)} ${run.id}`,
    description: `${run.status} · ${run.currentActivity} · ${run.modelSource} · ${truncate(run.task, 55)}`,
    value: { kind: "run", runId: run.id },
  }));
}

function renderContent(
  ctx: ExtensionCommandContext,
  theme: NestedPickerPanelTheme,
  keybindings: { matches(data: string, id: string): boolean },
  requestRender: () => void,
  store: SubagentStore,
  row: NestedPickerRow<RowValue>,
): Component | string[] {
  const value = row.value;
  if (value?.kind === "run" && value.runId)
    return new RunDetailsContent(
      ctx,
      theme as OverlayPanelTheme,
      requestRender,
      store,
      value.runId,
    );
  if (value?.kind === "setting" && value.tier)
    return new SettingsContent(ctx, theme, requestRender, keybindings, value.tier);
  if (value?.kind === "preset" && value.preset) {
    const p = value.preset;
    return [
      p.name,
      p.description ?? "No description.",
      `tier: ${p.tier ?? "unset"}`,
      `tools: ${p.tools ?? "unset"}`,
      "",
      p.body,
    ];
  }
  if (value?.kind === "help")
    return [
      "Runs: enter opens details; o opens overlay; x cancels; X cancels with notes.",
      "Settings: s select model, t thinking level, u unset, r reload.",
      "spawn_subagent defaults to the parent model and read-only tools.",
    ];
  return ["Nothing to show."];
}

class RunDetailsContent implements Component {
  private confirmCancel = false;

  constructor(
    private readonly ctx: ExtensionCommandContext,
    private readonly theme: OverlayPanelTheme,
    private readonly requestRender: () => void,
    private readonly store: SubagentStore,
    private readonly runId: string,
  ) {}

  render(): string[] {
    const run = this.store.get(this.runId);
    if (!run) return ["Run not found."];
    const canCancel = run.status === "queued" || run.status === "running";
    return [
      `${run.id} ${run.status} (${formatElapsed(run)})`,
      `model: ${run.modelId} (${formatRunSource(run)})`,
      `tools: ${run.tools}`,
      run.modelResolutionWarning ? `warning: ${run.modelResolutionWarning}` : "",
      "",
      truncate(run.task, 120),
      "",
      this.confirmCancel
        ? this.theme.fg("warning", "Press x again to cancel this subagent • c abort")
        : canCancel
          ? "o/enter overlay • x cancel"
          : "o/enter overlay",
    ].filter(Boolean);
  }

  handleInput(data: string): void {
    if (this.confirmCancel) {
      if (data === "x") this.abort();
      if (data === "c") {
        this.confirmCancel = false;
        this.requestRender();
      }
      return;
    }

    if (data === "o" || data === "\r") void this.openOverlay();
    if (data === "x") {
      this.confirmCancel = true;
      this.requestRender();
    }
  }

  invalidate(): void {}

  private abort(): void {
    const run = this.store.get(this.runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return;
    this.store.abort(run.id);
    this.confirmCancel = false;
    this.requestRender();
  }

  private async openOverlay(): Promise<void> {
    await this.ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        const panel = new OverlayPanel({
          title: `subagent ${this.runId}`,
          sections: this.overlaySections(theme as OverlayPanelTheme),
          theme: theme as OverlayPanelTheme,
          requestRender: () => tui.requestRender(),
          footerText: "q close • j/k scroll",
          onClose: () => done(),
        });
        const unsubscribe = this.store.subscribe(() => {
          panel.setSections(this.overlaySections(theme as OverlayPanelTheme));
        });
        return Object.assign(panel, { dispose: unsubscribe });
      },
      {
        overlay: true,
        overlayOptions: rightOverlayOptions({ width: "60%", minWidth: 72, maxHeight: "90%" }),
      },
    );
  }

  private overlaySections(theme: OverlayPanelTheme) {
    const run = this.store.get(this.runId);
    if (!run) return [{ title: "Missing", content: ["Run not found."] }];
    return [
      {
        title: "Summary",
        content: [
          `status: ${run.status}`,
          `activity: ${run.currentActivity}`,
          `elapsed: ${formatElapsed(run)}`,
          `model: ${run.modelId} (${run.modelSource})`,
          `tools: ${run.tools}`,
          ...(run.modelResolutionWarning ? [`warning: ${run.modelResolutionWarning}`] : []),
        ],
      },
      { title: "Task", content: run.task },
      ...(run.error ? [{ title: "Error", content: run.error }] : []),
      ...(run.finalText ? [{ title: "Final answer", content: run.finalText }] : []),
      { title: "Live session", content: new PiSessionTranscriptContent(run, theme) },
    ];
  }
}

class PiSessionTranscriptContent implements Component {
  constructor(
    private readonly run: SubagentRun,
    private readonly theme: OverlayPanelTheme,
  ) {}

  render(width: number): string[] {
    const events = this.run.events ?? [];
    if (!events.length && !this.run.transcript?.length) return ["Transcript not available yet."];

    const state = buildLiveSessionState(this.run);
    const lines: string[] = [];
    for (const entry of state.entries) {
      if (lines.length) lines.push("");
      if (entry.kind === "message") {
        const message = state.messages.get(entry.key);
        if (message) lines.push(...renderPiMessage(message, width));
      } else {
        const tool = state.tools.get(entry.key);
        if (tool) lines.push(renderPiTool(tool, this.theme));
      }
    }
    return lines.length ? lines : ["Transcript not available yet."];
  }

  invalidate(): void {}
}

interface LiveSessionState {
  entries: Array<{ kind: "message" | "tool"; key: string }>;
  messages: Map<string, unknown>;
  tools: Map<string, LiveToolState>;
}

interface LiveToolState {
  id: string;
  name: string;
  args: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  started: boolean;
}

function buildLiveSessionState(run: SubagentRun): LiveSessionState {
  const entries: LiveSessionState["entries"] = [];
  const messages = new Map<string, unknown>();
  const tools = new Map<string, LiveToolState>();
  const pushEntry = (kind: "message" | "tool", key: string): void => {
    if (!entries.some((entry) => entry.kind === kind && entry.key === key))
      entries.push({ kind, key });
  };

  for (const event of run.events ?? []) {
    if (
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end"
    ) {
      if ((event.message as { role?: unknown }).role === "toolResult") continue;
      const key = liveMessageKey(event.message);
      messages.set(key, event.message);
      pushEntry("message", key);
    } else if (event.type === "tool_execution_start") {
      tools.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        started: true,
      });
      pushEntry("tool", event.toolCallId);
    } else if (event.type === "tool_execution_update") {
      const current: LiveToolState = tools.get(event.toolCallId) ?? {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        started: true,
      };
      current.args = event.args;
      current.partialResult = event.partialResult;
      tools.set(event.toolCallId, current);
      pushEntry("tool", event.toolCallId);
    } else if (event.type === "tool_execution_end") {
      const current: LiveToolState = tools.get(event.toolCallId) ?? {
        id: event.toolCallId,
        name: event.toolName,
        args: {},
        started: true,
      };
      current.result = event.result;
      current.isError = event.isError;
      tools.set(event.toolCallId, current);
      pushEntry("tool", event.toolCallId);
    }
  }

  if (!entries.length) {
    for (const message of run.transcript ?? []) {
      if ((message as { role?: unknown }).role === "toolResult") continue;
      const key = liveMessageKey(message);
      messages.set(key, message);
      pushEntry("message", key);
    }
  }

  return { entries, messages, tools };
}

function renderPiMessage(message: unknown, width: number): string[] {
  const role = (message as { role?: unknown }).role;
  if (role === "assistant") {
    return new AssistantMessageComponent(message as any, false, getMarkdownTheme()).render(width);
  }
  if (role === "user") {
    return new UserMessageComponent(
      compactDisplayedSubagentPrompt(
        messageContentToText((message as { content?: unknown }).content),
      ),
      getMarkdownTheme(),
    ).render(width);
  }
  return [JSON.stringify(message, null, 2)];
}

function renderPiTool(tool: LiveToolState, theme: OverlayPanelTheme): string {
  return theme.fg("muted", formatCompactToolSummary(tool));
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
        return String((part as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function liveMessageKey(message: unknown): string {
  const record =
    Boolean(message) && typeof message === "object" ? (message as Record<string, unknown>) : {};
  const role = typeof record.role === "string" ? record.role : "unknown";
  const timestamp = typeof record.timestamp === "number" ? record.timestamp : 0;
  const provider = typeof record.provider === "string" ? record.provider : "";
  const model = typeof record.model === "string" ? record.model : "";
  return `${role}:${timestamp}:${provider}:${model}`;
}

class SettingsContent implements Component {
  private lines = ["Loading settings…"];
  private busy = false;
  private picker:
    | { kind: "model" | "thinking"; title: string; choices: string[]; selectedIndex: number }
    | undefined;
  private confirmUnset = false;

  constructor(
    private readonly ctx: ExtensionCommandContext,
    private readonly theme: NestedPickerPanelTheme,
    private readonly requestRender: () => void,
    private readonly keybindings: { matches(data: string, id: string): boolean },
    private readonly tier: SettingTier,
  ) {
    void this.reload();
  }

  render(): string[] {
    if (!this.picker) return this.lines;
    return [
      this.picker.title,
      ...this.picker.choices.map((choice, index) => {
        const line = `${index === this.picker?.selectedIndex ? "→" : " "} ${choice}`;
        return index === this.picker?.selectedIndex ? this.theme.fg("accent", line) : line;
      }),
      "",
      "↑↓ navigate • enter select • c cancel",
    ];
  }
  invalidate(): void {}

  handleInput(data: string): void {
    if (this.busy) return;
    if (this.picker) {
      this.handlePickerInput(data);
      return;
    }
    if (this.confirmUnset) {
      if (data === "u") void this.unsetNow();
      if (data === "c") {
        this.confirmUnset = false;
        void this.reload();
      }
      return;
    }
    if (data === "s") this.showModelPicker();
    if (data === "t") void this.showThinkingPicker();
    if (data === "u") this.showUnsetConfirm();
    if (data === "r") void this.reload();
  }

  private async reload(): Promise<void> {
    const { settings, warnings } = await readSubagentSettings();
    const mapping = settings.tiers[this.tier];
    this.lines = [
      `${this.tier} tier`,
      `model: ${mapping?.model ?? "unset (falls back to parent)"}`,
      `thinking: ${mapping?.thinkingLevel ?? "unset"}`,
      ...warnings.map((warning) => this.theme.fg("warning", warning)),
      "",
      "s select model • t thinking level • u unset • r reload",
    ];
    this.requestRender();
  }

  private showModelPicker(): void {
    const models = this.ctx.modelRegistry
      .getAll()
      .filter((model) => this.ctx.modelRegistry.hasConfiguredAuth(model));
    const choices = models.map(formatCanonicalModelId).sort();
    this.picker = {
      kind: "model",
      title: `Select ${this.tier} tier model`,
      choices,
      selectedIndex: 0,
    };
    this.requestRender();
  }

  private async showThinkingPicker(): Promise<void> {
    const current = (await readSubagentSettings()).settings.tiers[this.tier];
    if (!current) {
      this.ctx.ui.notify("Select a model with s before setting thinking level", "warning");
      return;
    }
    this.picker = {
      kind: "thinking",
      title: `Select ${this.tier} thinking level`,
      choices: ["unset", ...THINKING_LEVELS],
      selectedIndex: 0,
    };
    this.requestRender();
  }

  private showUnsetConfirm(): void {
    this.confirmUnset = true;
    this.lines = [
      `${this.tier} tier`,
      this.theme.fg("warning", `Press u again to unset ${this.tier} tier mapping • c cancel`),
    ];
    this.requestRender();
  }

  private handlePickerInput(data: string): void {
    if (!this.picker) return;
    if (data === "c") {
      this.picker = undefined;
      void this.reload();
      return;
    }
    if (!this.picker.choices.length) return;
    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
      this.picker.selectedIndex =
        (this.picker.selectedIndex + this.picker.choices.length - 1) % this.picker.choices.length;
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
      this.picker.selectedIndex = (this.picker.selectedIndex + 1) % this.picker.choices.length;
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm") || data === "\r") {
      void this.applyPickerChoice(this.picker.choices[this.picker.selectedIndex]);
    }
  }

  private async applyPickerChoice(choice: string | undefined): Promise<void> {
    if (!choice || !this.picker) return;
    const pickerKind = this.picker.kind;
    await this.withBusy(async () => {
      if (pickerKind === "thinking") {
        const current = (await readSubagentSettings()).settings.tiers[this.tier];
        if (!current) return;
        await writeSubagentTier(this.tier, {
          model: current.model,
          thinkingLevel: choice === "unset" ? undefined : normalizeThinkingLevel(choice),
        });
      } else {
        const current = (await readSubagentSettings()).settings.tiers[this.tier];
        await writeSubagentTier(this.tier, {
          model: choice,
          thinkingLevel: current?.thinkingLevel,
        });
      }
    });
  }

  private async unsetNow(): Promise<void> {
    await this.withBusy(async () => writeSubagentTier(this.tier, undefined));
  }

  private async withBusy(action: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.picker = undefined;
    this.confirmUnset = false;
    this.lines = ["Saving…"];
    this.requestRender();
    try {
      await action();
    } catch (error) {
      this.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.busy = false;
      await this.reload();
    }
  }
}

function buildWidgetLines(runs: readonly SubagentRun[]): string[] {
  return [
    "subagents",
    ...runs
      .slice(0, 3)
      .map(
        (run) =>
          `${statusIcon(run.status)} ${run.id} ${run.currentActivity} · ${truncate(run.task, 60)}`,
      ),
  ];
}
