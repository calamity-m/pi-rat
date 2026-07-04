import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** Marker appended to the active theme in the interactive selector. */
const CURRENT_THEME_MARKER = " (current)";

/** Cached theme names used by slash-command argument completion. */
let themeCompletionItems: AutocompleteItem[] = [];

/** Register the `/theme` command for switching among loaded Pi themes. */
export function registerThemeSwitcher(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    refreshThemeCompletionItems(ctx);
  });

  pi.on("resources_discover", (_event, ctx) => {
    refreshThemeCompletionItems(ctx);
  });

  pi.registerCommand("theme", {
    description: "Switch theme",
    getArgumentCompletions: (prefix: string) => {
      const filtered = themeCompletionItems.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      refreshThemeCompletionItems(ctx);
      const themeName = args.trim();
      if (themeName) {
        setThemeByName(ctx, themeName);
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("usage: /theme <name>", "info");
        return;
      }

      const currentName = ctx.ui.theme.name ?? "unknown";
      const items = ctx.ui
        .getAllThemes()
        .map((theme) =>
          theme.name === currentName ? `${theme.name}${CURRENT_THEME_MARKER}` : theme.name,
        );
      const selected = await ctx.ui.select("Select theme", items);
      if (!selected) return;

      setThemeByName(ctx, selected.replace(CURRENT_THEME_MARKER, ""));
    },
  });
}

export default function theme(pi: ExtensionAPI): void {
  registerThemeSwitcher(pi);
}

/** Refresh cached theme completion items from the current UI context. */
function refreshThemeCompletionItems(ctx: ExtensionContext): void {
  themeCompletionItems = ctx.ui.getAllThemes().map(
    (theme): AutocompleteItem => ({
      value: theme.name,
      label: theme.name,
    }),
  );
}

/** Switch to a theme by name and show the command result. */
function setThemeByName(ctx: ExtensionCommandContext, themeName: string): void {
  const result = ctx.ui.setTheme(themeName);
  if (result.success) {
    ctx.ui.notify(`Theme: ${themeName}`, "info");
    return;
  }

  ctx.ui.notify(result.error ?? "Failed to set theme", "error");
}
