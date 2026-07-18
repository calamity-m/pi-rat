import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type SettingItem, SettingsList } from "@earendil-works/pi-tui";

import { PanelChrome } from "../lib/search-panel.ts";
import { currentThinkingBorderColor } from "../lib/thinking-border.ts";

interface ToolsState {
  enabledTools: string[];
}

/** Register /tools for enabling and disabling built-in and custom tools. */
export default function toolsExtension(pi: ExtensionAPI): void {
  let enabledTools = new Set<string>();

  function applyTools(): void {
    pi.setActiveTools([...enabledTools]);
  }

  function persistState(): void {
    pi.appendEntry<ToolsState>("tools-config", {
      enabledTools: [...enabledTools],
    });
  }

  function restoreFromBranch(ctx: ExtensionContext): void {
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    let savedTools: string[] | undefined;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "tools-config") continue;
      const data = entry.data as ToolsState | undefined;
      if (data?.enabledTools) savedTools = data.enabledTools;
    }

    if (!savedTools) {
      enabledTools = new Set(pi.getActiveTools());
      return;
    }

    enabledTools = new Set(savedTools.filter((name) => available.has(name)));
    applyTools();
  }

  pi.registerCommand("tools", {
    description: "Enable or disable built-in and custom tools",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/tools requires TUI mode", "error");
        return;
      }

      const allTools = pi.getAllTools();
      // Include tools registered after session_start and reflect the runtime's true state.
      enabledTools = new Set(pi.getActiveTools());

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const items: SettingItem[] = allTools.map((tool) => ({
          id: tool.name,
          label: tool.name,
          description: toolDescription(tool),
          currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        }));

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (name, value) => {
            if (value === "enabled") enabledTools.add(name);
            else enabledTools.delete(name);
            applyTools();
            persistState();
          },
          () => done(),
          { enableSearch: true },
        );
        const chrome = new PanelChrome(theme, currentThinkingBorderColor(ctx, theme));

        return {
          render: (width) => chrome.render("tools", width, settingsList.render(width)),
          invalidate: () => settingsList.invalidate(),
          handleInput: (data) => {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreFromBranch(ctx);
  });
}

function toolDescription(tool: ToolInfo): string {
  const source = tool.sourceInfo?.source ?? "unknown source";
  return tool.description ? `${source} — ${tool.description}` : source;
}
