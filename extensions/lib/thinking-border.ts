import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { NestedPickerBorderColor, NestedPickerPanelTheme } from "./nested-picker-panel.ts";

const THINKING_BORDER_TOKENS: Record<string, string> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
};

/** Return the current prompt-editor border color for extension-owned nested panels. */
export function currentThinkingBorderColor(
  ctx: ExtensionCommandContext,
  theme: NestedPickerPanelTheme,
): NestedPickerBorderColor {
  const thinkingLevel = currentThinkingLevel(ctx);
  const token = THINKING_BORDER_TOKENS[thinkingLevel] ?? THINKING_BORDER_TOKENS.off;
  return (text) => theme.fg(token, text);
}

function currentThinkingLevel(ctx: ExtensionCommandContext): string {
  if (!ctx.model?.reasoning) return "off";

  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type === "thinking_level_change") return entry.thinkingLevel;
  }

  return "medium";
}
