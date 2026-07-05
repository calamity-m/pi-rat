import path from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1F\x7F-\x9F]/g;

function fitBorder(
  left: string,
  right: string,
  width: number,
  border: (text: string) => string,
  fill: (text: string) => string = border,
): string {
  if (width <= 0) return "";
  if (width === 1) return border("─");

  let leftText = left;
  let rightText = right;
  const fixedWidth = 2;
  const minimumGap = 3;

  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(rightText) > 0
  ) {
    rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
  }
  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(leftText) > 0
  ) {
    leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
  }

  const gapWidth = Math.max(
    0,
    width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText),
  );
  return `${border("─")}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

function findEditorBottomBorderIndex(lines: readonly string[], width: number): number {
  for (let index = lines.length - 1; index >= 1; index--) {
    if (isEditorBorderLine(lines[index] ?? "", width)) return index;
  }
  return Math.max(0, lines.length - 1);
}

function isEditorBorderLine(line: string, width: number): boolean {
  const plain = line.replace(ANSI_ESCAPE_PATTERN, "");
  if (visibleWidth(plain) !== width) return false;
  return /^─+$/.test(plain) || /^─── [↑↓] \d+ more ─*$/.test(plain);
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function sanitizeLabel(label: string | undefined): string | undefined {
  const sanitized = label
    ?.replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .trim();
  return sanitized && sanitized.length > 0 ? sanitized : undefined;
}

function terminalTitle(cwd: string, label: string | undefined): string {
  const cwdName = path.basename(cwd) || cwd;
  return label ? `π - ${label} - ${cwdName}` : `π - ${cwdName}`;
}

function updateInstanceTitle(ctx: ExtensionContext, label: string | undefined): void {
  if (!ctx.hasUI) return;
  ctx.ui.setTitle(terminalTitle(ctx.cwd, label));
}

function formatContext(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  if (!usage || usage.percent === null || !contextWindow) return "ctx ?";
  return `ctx ${Math.round(usage.percent)}%/${Math.round(contextWindow / 1000)}k`;
}

function compactNumber(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

function branchLabel(branch: string | undefined): string {
  return branch ? ` ${branch}` : "no git branch";
}

class EmptyFooter implements Component {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}

export default function footer(pi: ExtensionAPI) {
  let activeTui: TUI | undefined;
  let spinnerIndex = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let isWorking = false;
  let branch: string | undefined;

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
  };

  const requestRender = () => activeTui?.requestRender();

  const currentLabel = () => sanitizeLabel(pi.getSessionName());

  const refreshInstanceIdentity = (ctx: ExtensionContext) => {
    updateInstanceTitle(ctx, currentLabel());
    requestRender();
  };

  const refreshBranch = async (ctx: ExtensionContext) => {
    const result = await pi
      .exec("git", ["branch", "--show-current"], { cwd: ctx.cwd })
      .catch(() => undefined);
    const stdout = result?.stdout.trim();
    branch = stdout && stdout.length > 0 ? stdout : undefined;
    requestRender();
  };

  pi.on("session_start", (_event, ctx) => {
    refreshInstanceIdentity(ctx);
    if (ctx.mode !== "tui") return;

    ctx.ui.setWorkingVisible(false);
    ctx.ui.setFooter(() => new EmptyFooter());

    void refreshBranch(ctx);

    class FooterEditor extends CustomEditor {
      constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
        super(tui, theme, keybindings, { paddingX: 0 });
        activeTui = tui;
      }

      render(width: number): string[] {
        const lines = super.render(width);
        if (lines.length < 2) return lines;

        const theme = ctx.ui.theme;
        const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
        const thinking = pi.getThinkingLevel();
        const label = currentLabel();
        const stateText = isWorking
          ? theme.fg("accent", ` ${spinnerFrames[spinnerIndex]} working`)
          : theme.fg("success", " ● ready");
        const topLeft = label
          ? `${stateText}${theme.fg("dim", " · ")}${theme.fg("muted", label)} `
          : `${stateText} `;
        const topRight = theme.fg("muted", ` ${branchLabel(branch)} `);
        const bottomLeft = theme.fg("muted", ` ${model} · thinking ${thinking} `);
        const bottomRight = theme.fg("muted", ` ${formatContext(ctx)} · ${formatCwd(ctx.cwd)} `);
        const borderColor = (text: string) => this.borderColor(text);

        lines[0] = fitBorder(topLeft, topRight, width, borderColor);
        lines[findEditorBottomBorderIndex(lines, width)] = fitBorder(
          bottomLeft,
          bottomRight,
          width,
          borderColor,
        );
        return lines;
      }
    }

    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new FooterEditor(tui, theme, keybindings),
    );
  });

  pi.on("agent_start", () => {
    isWorking = true;
    stopSpinner();
    spinnerTimer = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
      requestRender();
    }, 80);
    requestRender();
  });

  pi.on("agent_end", () => {
    isWorking = false;
    stopSpinner();
    requestRender();
  });

  pi.on("session_info_changed", (_event, ctx) => {
    refreshInstanceIdentity(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    ctx.ui.setStatus("model", `🤖 ${event.model.id}`);
    requestRender();
  });

  pi.on("thinking_level_select", (event, ctx) => {
    ctx.ui.setStatus("thinking", `🧠 ${event.level}`);
    requestRender();
  });

  pi.on("turn_end", (_event, ctx) => {
    let input = 0;
    let output = 0;
    let cost = 0;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const message = entry.message as AssistantMessage;
      input += message.usage.input;
      output += message.usage.output;
      cost += message.usage.cost.total;
    }

    ctx.ui.setStatus(
      "usage",
      `↑${compactNumber(input)} ↓${compactNumber(output)} $${cost.toFixed(3)}`,
    );
    void refreshBranch(ctx);
  });

  pi.on("session_shutdown", () => {
    stopSpinner();
    activeTui = undefined;
  });

  pi.registerCommand("label", {
    description: "Set or show this Pi instance label, backed by the session name",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const label = sanitizeLabel(args);
      if (!label) {
        const existing = currentLabel();
        ctx.ui.notify(existing ? `Label: ${existing}` : "No label set", "info");
        return;
      }

      if (label === "--clear") {
        pi.setSessionName("");
        refreshInstanceIdentity(ctx);
        ctx.ui.notify("Label cleared", "info");
        return;
      }

      pi.setSessionName(label);
      refreshInstanceIdentity(ctx);
      ctx.ui.notify(`Label: ${label}`, "info");
    },
  });

  pi.registerCommand("footer-reset", {
    description: "Restore Pi's built-in footer, editor, and working indicator",
    handler: async (_args, ctx) => {
      stopSpinner();
      ctx.ui.setFooter(undefined);
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setWorkingVisible(true);
      ctx.ui.notify("Restored built-in Pi footer", "info");
    },
  });
}
