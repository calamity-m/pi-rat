import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
        await setThemeByName(ctx, themeName);
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

      await setThemeByName(ctx, selected.replace(CURRENT_THEME_MARKER, ""));
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
async function setThemeByName(ctx: ExtensionCommandContext, themeName: string): Promise<void> {
  const result = ctx.ui.setTheme(themeName);
  if (!result.success) {
    ctx.ui.notify(result.error ?? "Failed to set theme", "error");
    return;
  }

  const projectUpdate = await updateProjectThemeOverride(ctx, themeName);
  const suffix = projectUpdate.updated ? " (project override updated)" : "";
  ctx.ui.notify(`Theme: ${themeName}${suffix}`, "info");
  if (projectUpdate.error) {
    ctx.ui.notify(`Theme set, but project settings were not updated: ${projectUpdate.error}`, "error");
  }
}

/**
 * Keep an existing project-local theme override in sync with `/theme`.
 *
 * Pi persists `ctx.ui.setTheme()` globally, but project settings override global settings
 * after `/reload`. Only update an existing project `theme`; do not create project-local
 * settings for users who rely on the global theme.
 */
async function updateProjectThemeOverride(
  ctx: Pick<ExtensionCommandContext, "cwd" | "isProjectTrusted">,
  themeName: string,
): Promise<{ updated: boolean; error?: string }> {
  if (!ctx.isProjectTrusted()) return { updated: false };

  const settingsPath = join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return { updated: false };
    return { updated: false, error: error instanceof Error ? error.message : String(error) };
  }

  let settings: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) return { updated: false, error: "settings.json is not an object" };
    settings = parsed;
  } catch (error) {
    return { updated: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (!Object.prototype.hasOwnProperty.call(settings, "theme")) return { updated: false };
  if (settings.theme === themeName) return { updated: false };

  settings.theme = themeName;
  try {
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch (error) {
    return { updated: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { updated: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export const __themeForTest = { updateProjectThemeOverride };
