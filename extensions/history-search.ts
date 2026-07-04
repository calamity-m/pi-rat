import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

import { SearchPanel } from "./lib/search-panel.ts";

/** Maximum number of live matches to show in the picker. */
const MAX_RESULTS = 10;

/** Default shortcut, avoiding Pi's built-in Ctrl+R session-rename binding. */
const DEFAULT_HISTORY_SEARCH_SHORTCUT = "f8";

/** Message role that is useful to paste back into the editor. */
type SearchableRole = "user";

/** One searchable message extracted from a session. */
export interface SearchableMessage {
  /** Session file path, or a synthetic current-session marker when not persisted yet. */
  sessionPath: string;
  /** Human-readable session name, first prompt, or path. */
  sessionTitle: string;
  /** Working directory recorded in the session header, when available. */
  cwd?: string;
  /** Message role shown in the picker. */
  role: SearchableRole;
  /** Plain text that is searched and inserted into the editor when selected. */
  text: string;
  /** Message or entry timestamp in Unix milliseconds. */
  timestamp: number;
}

/** Search result with a UI label and source message. */
export interface HistorySearchResult {
  /** Unique picker label. */
  label: string;
  /** Message represented by the label. */
  message: SearchableMessage;
}

/** Process-local cache for saved-session history so Ctrl+R can open immediately. */
interface SavedHistoryCache {
  /** Last successfully loaded saved-session messages. */
  messages: SearchableMessage[];
  /** Whether at least one full saved-session load has completed. */
  loaded: boolean;
  /** In-flight cache refresh, shared by startup warmup and interactive search. */
  loading?: Promise<SearchableMessage[]>;
}

/** Saved history cache shared by all invocations in this extension runtime. */
const savedHistoryCache: SavedHistoryCache = { messages: [], loaded: false };

/**
 * Read the centralized shortcut at extension load time. The persisted value is
 * an arbitrary user string; Pi validates the exact key syntax at registration, so
 * it is surfaced as a `KeyId` here.
 */
function readHistorySearchShortcut(): KeyId {
  return DEFAULT_HISTORY_SEARCH_SHORTCUT as KeyId;
}

/** Register reverse history search via `/history` and the configured shortcut. */
export function registerHistorySearch(pi: ExtensionAPI): void {
  pi.registerCommand("history", {
    description: "Search old user messages and populate the editor with a selection",
    handler: async (args, ctx) => {
      await runHistorySearch(ctx, args.trim());
    },
  });

  pi.registerShortcut(readHistorySearchShortcut(), {
    description: "Search old user messages",
    handler: async (ctx) => {
      await runHistorySearch(ctx, "");
    },
  });

  pi.on("session_start", () => {
    void ensureSavedHistoryCache().catch(() => {
      // Warmup is opportunistic; interactive search can retry later.
    });
  });
}

export default function historySearch(pi: ExtensionAPI): void {
  registerHistorySearch(pi);
}

/** Open live search, then fill the editor with the selected text. */
async function runHistorySearch(
  ctx: ExtensionContext | ExtensionCommandContext,
  initialQuery: string,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("history search requires an interactive UI", "warning");
    return;
  }

  const currentSessionPath = ctx.sessionManager.getSessionFile();
  const currentMessages = currentSearchableMessages(ctx);
  const initialMessages = mergeSearchableMessages(
    currentMessages,
    savedHistoryCache.messages.filter((message) => message.sessionPath !== currentSessionPath),
  );
  const refresh = ensureSavedHistoryCache();
  let component: SearchPanel<SearchableMessage> | undefined;

  if (!savedHistoryCache.loaded) ctx.ui.setStatus("history-search", "loading old sessions…");
  try {
    const result = await ctx.ui.custom<SearchableMessage | undefined>(
      (tui, theme, keybindings, done) => {
        component = new SearchPanel<SearchableMessage>({
          title: "history",
          rows: initialMessages,
          initialQuery,
          visibleRows: MAX_RESULTS,
          emptyQueryText: "Type to search saved user messages…",
          noResultsText: "No matching user messages",
          footerText: "↑↓ navigate • enter populate editor • esc cancel",
          theme,
          keybindings,
          requestRender: () => tui.requestRender(),
          filterRows: (messages, query) =>
            searchMessages(messages, query, Number.POSITIVE_INFINITY).map(
              (result) => result.message,
            ),
          renderRow: (message, { query, index }) => formatResultLabel(message, query, index + 1),
          onSelect: done,
          onCancel: () => done(undefined),
        });
        void refresh
          .then((messages) => {
            component?.setRows(
              mergeSearchableMessages(
                currentSearchableMessages(ctx),
                messages.filter((message) => message.sessionPath !== currentSessionPath),
              ),
            );
          })
          .catch(() => {
            // Keep the immediately opened current-session search usable if old-session loading fails.
          });
        return component;
      },
    );
    component = undefined;
    if (!result) return;
    ctx.ui.setEditorText(result.text);
  } finally {
    component = undefined;
    ctx.ui.setStatus("history-search", undefined);
  }
}

/** Return current-session messages without touching disk so the picker can open immediately. */
function currentSearchableMessages(
  ctx: ExtensionContext | ExtensionCommandContext,
): SearchableMessage[] {
  const currentSessionPath = ctx.sessionManager.getSessionFile();
  const currentTitle =
    ctx.sessionManager.getSessionName() ?? currentSessionPath ?? "current session";
  return entriesToSearchableMessages(ctx.sessionManager.getEntries(), {
    sessionPath: currentSessionPath ?? "<current-session>",
    sessionTitle: currentTitle,
    cwd: ctx.cwd,
  });
}

/** Start or reuse a saved-session cache refresh. */
function ensureSavedHistoryCache(): Promise<SearchableMessage[]> {
  if (savedHistoryCache.loading) return savedHistoryCache.loading;
  savedHistoryCache.loading = loadSavedHistoryMessages()
    .then((messages) => {
      savedHistoryCache.messages = messages;
      savedHistoryCache.loaded = true;
      return messages;
    })
    .finally(() => {
      savedHistoryCache.loading = undefined;
    });
  return savedHistoryCache.loading;
}

/** Load searchable messages from every known saved Pi session. */
async function loadSavedHistoryMessages(): Promise<SearchableMessage[]> {
  const messages: SearchableMessage[] = [];
  const infos = await SessionManager.listAll();
  for (const info of infos) {
    try {
      const manager = SessionManager.open(info.path);
      messages.push(
        ...entriesToSearchableMessages(manager.getEntries(), {
          sessionPath: info.path,
          sessionTitle: sessionTitle(info),
          cwd: info.cwd,
        }),
      );
    } catch {
      // Skip unreadable or concurrently deleted sessions; search should be best-effort.
    }
  }
  return messages;
}

/** Merge current and cached saved messages, dropping duplicate persisted current-session rows. */
function mergeSearchableMessages(
  currentMessages: readonly SearchableMessage[],
  savedMessages: readonly SearchableMessage[],
): SearchableMessage[] {
  const seen = new Set<string>();
  const merged: SearchableMessage[] = [];
  for (const message of [...currentMessages, ...savedMessages]) {
    const key = `${message.sessionPath}\0${message.timestamp}\0${message.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(message);
  }
  return merged;
}

/** Convert session entries into plain searchable user messages. */
export function entriesToSearchableMessages(
  entries: readonly SessionEntry[],
  session: Pick<SearchableMessage, "sessionPath" | "sessionTitle" | "cwd">,
): SearchableMessage[] {
  const messages: SearchableMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role !== "user") continue;

    const text = messageText(message.content).trim();
    if (!text) continue;

    messages.push({
      ...session,
      role: message.role,
      text,
      timestamp:
        typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp),
    });
  }
  return messages;
}

/** Search messages case-insensitively and return most-recent-first picker results. */
export function searchMessages(
  messages: readonly SearchableMessage[],
  query: string,
  limit = MAX_RESULTS,
): HistorySearchResult[] {
  const normalizedQuery = query.toLocaleLowerCase();
  return messages
    .filter((message) => message.text.toLocaleLowerCase().includes(normalizedQuery))
    .sort(
      (a, b) =>
        scoreMessage(b, normalizedQuery) - scoreMessage(a, normalizedQuery) ||
        b.timestamp - a.timestamp,
    )
    .slice(0, limit)
    .map((message, index) => ({
      label: formatResultLabel(message, query, index + 1),
      message,
    }));
}

/** Extract plain text from string or text-block message content. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
      ),
    )
    .map((block) => block.text)
    .join("\n");
}

/** Build a compact, unique label for one picker result. */
function formatResultLabel(message: SearchableMessage, query: string, index: number): string {
  const when = Number.isFinite(message.timestamp)
    ? new Date(message.timestamp).toISOString().slice(0, 10)
    : "unknown-date";
  const title = truncate(message.sessionTitle.replace(/\s+/g, " "), 28);
  const snippet = truncate(snippetAroundMatch(message.text, query).replace(/\s+/g, " "), 80);
  return `${index}. ${when} ${message.role} · ${title} · ${snippet}`;
}

/** Score exact and word-start matches above generic substring matches. */
function scoreMessage(message: SearchableMessage, normalizedQuery: string): number {
  const text = message.text.toLocaleLowerCase();
  const index = text.indexOf(normalizedQuery);
  if (index < 0) return 0;
  const wordStartBonus = index === 0 || /\s/.test(text[index - 1] ?? "") ? 50 : 0;
  return 1000 - Math.min(index, 500) + wordStartBonus;
}

/** Prefer a human-readable session name, then its first message, then its path. */
function sessionTitle(info: SessionInfo): string {
  return info.name?.trim() || info.firstMessage?.trim() || info.path;
}

/** Return a short text window centered near the first match. */
function snippetAroundMatch(text: string, query: string): string {
  const normalizedText = text.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  const matchIndex = normalizedText.indexOf(normalizedQuery);
  if (matchIndex < 0) return text;

  const start = Math.max(0, matchIndex - 24);
  const end = Math.min(text.length, matchIndex + query.length + 56);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/** Truncate long labels without splitting the ellipsis logic throughout the file. */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Pure helpers exposed for Node tests. */
export const __historySearchForTest = {
  entriesToSearchableMessages,
  messageText,
  searchMessages,
};
