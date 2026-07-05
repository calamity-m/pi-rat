import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import {
  NestedPickerPanel,
  type NestedPickerPanelTheme,
  type NestedPickerRow,
} from "../lib/nested-picker-panel.ts";
import {
  buildUsageDetails,
  CHATGPT_BASE_URL,
  getTokenMetadata,
  isOpenAICodexProvider,
  parseUsageSnapshot,
  type UsageSnapshot,
} from "./subscriptions/index.ts";
import {
  aggregateTokenUsage,
  buildTokenUsageDetails,
  readSessionTexts,
  type TokenUsageReport,
} from "./tokens/index.ts";

const USAGE_FETCH_TIMEOUT_MS = 15_000;

interface UsageRowValue {
  kind: "category" | "chatgpt-codex" | "token-provider-model" | "tokens-empty" | "tokens-error";
  providerModel?: string;
  tokenReport?: TokenUsageReport;
  sessionDir?: string;
  error?: string;
}

const subscriptionUsageRows: readonly NestedPickerRow<UsageRowValue>[] = [
  {
    id: "subscription-usage",
    label: "Subscription usage",
    description: "ChatGPT subscription limits",
    value: { kind: "category" },
    children: [
      {
        id: "chatgpt-codex",
        label: "ChatGPT Codex",
        description: "Uses the active openai-codex OAuth login",
        value: { kind: "chatgpt-codex" },
      },
    ],
  },
];

/** Register the /usage command for ChatGPT Codex subscription usage. */
export default function usageExtension(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "Show subscription usage details",
    handler: async (_args, ctx) => {
      if (ctx.mode === "tui") {
        await showUsagePicker(ctx);
        return;
      }

      await showUsageFallback(ctx);
    },
  });
}

async function showUsagePicker(ctx: ExtensionCommandContext): Promise<void> {
  const rows = await buildUsageRows(ctx);

  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    return new NestedPickerPanel<UsageRowValue>({
      title: "usage",
      rows,
      visibleRows: 6,
      theme,
      keybindings,
      requestRender: () => tui.requestRender(),
      onCancel: () => done(),
      renderContent: ({ row }) => {
        if (row.value?.kind === "chatgpt-codex") {
          return new UsageDetailsContent(ctx, theme, () => tui.requestRender());
        }
        if (row.value?.kind === "token-provider-model") {
          return buildTokenUsageDetails(
            row.value.tokenReport!,
            row.value.sessionDir,
            row.value.providerModel,
          );
        }
        if (row.value?.kind === "tokens-empty") {
          return buildTokenUsageDetails(row.value.tokenReport!, row.value.sessionDir);
        }
        if (row.value?.kind === "tokens-error") {
          return [
            theme.fg("warning", "Could not load local token usage."),
            row.value.error ?? "Unknown error",
            "",
            "Token usage is read from local Pi session JSONL files.",
          ];
        }
        return ["Select a usage report."];
      },
    });
  });
}

async function showUsageFallback(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) return;

  try {
    const snapshot = await fetchChatGPTCodexUsage(ctx);
    ctx.ui.notify(buildUsageDetails(snapshot, ctx.model?.provider).join("\n"), "info");
  } catch (error) {
    ctx.ui.notify(usageErrorMessage(error), "warning");
  }
}

class UsageDetailsContent implements Component {
  private lines = ["Loading ChatGPT Codex usage…"];

  constructor(
    private readonly ctx: ExtensionCommandContext,
    private readonly theme: NestedPickerPanelTheme,
    private readonly requestRender: () => void,
  ) {
    void this.load();
  }

  render(): string[] {
    return this.lines;
  }

  invalidate(): void {}

  private async load(): Promise<void> {
    try {
      const snapshot = await fetchChatGPTCodexUsage(this.ctx);
      this.lines = buildUsageDetails(snapshot, this.ctx.model?.provider);
    } catch (error) {
      this.lines = [
        this.theme.fg("warning", "Could not load ChatGPT Codex usage."),
        usageErrorMessage(error),
        "",
        "Use an openai-codex model and run /login if Pi has no ChatGPT OAuth token.",
      ];
    } finally {
      this.requestRender();
    }
  }
}

async function buildUsageRows(
  ctx: ExtensionCommandContext,
): Promise<readonly NestedPickerRow<UsageRowValue>[]> {
  return [
    ...subscriptionUsageRows,
    {
      id: "tokens",
      label: "Tokens",
      description: "Current project token usage by provider/model",
      value: { kind: "category" },
      children: await buildTokenProviderModelRows(ctx.sessionManager.getSessionDir(), {
        emptyDescription: "No assistant usage in current project sessions",
        recursive: false,
      }),
    },
    {
      id: "global-tokens",
      label: "Global Tokens",
      description: "All Pi session token usage by provider/model",
      value: { kind: "category" },
      children: await buildTokenProviderModelRows(join(homedir(), ".pi", "agent", "sessions"), {
        emptyDescription: "No assistant usage in global Pi sessions",
        recursive: true,
      }),
    },
  ];
}

async function buildTokenProviderModelRows(
  sessionDir: string,
  options: { emptyDescription: string; recursive: boolean },
): Promise<readonly NestedPickerRow<UsageRowValue>[]> {
  try {
    const report = aggregateTokenUsage(await readSessionTexts(sessionDir, options.recursive));
    if (report.providerModels.length === 0) {
      return [
        {
          id: "tokens-empty",
          label: "No token usage found",
          description: options.emptyDescription,
          value: { kind: "tokens-empty", tokenReport: report, sessionDir },
        },
      ];
    }

    return report.providerModels.map((entry) => ({
      id: `token-${rowId(entry.providerModel)}`,
      label: entry.providerModel,
      description: `${entry.allTime.total} all-time tokens, ${entry.last30d.total} in 30d`,
      value: {
        kind: "token-provider-model",
        providerModel: entry.providerModel,
        tokenReport: report,
        sessionDir,
      },
    }));
  } catch (error) {
    return [
      {
        id: "tokens-error",
        label: "Could not load token usage",
        description: usageErrorMessage(error),
        value: { kind: "tokens-error", error: usageErrorMessage(error) },
      },
    ];
  }
}

function rowId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "unknown"
  );
}

async function fetchChatGPTCodexUsage(ctx: ExtensionCommandContext): Promise<UsageSnapshot> {
  const model = ctx.model;
  if (!model || !isOpenAICodexProvider(model.provider)) {
    throw new Error(
      `ChatGPT subscription usage requires an active openai-codex provider; current provider is ${model?.provider ?? "none"}.`,
    );
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Could not load ChatGPT OAuth credential: ${auth.error}`);
  if (!auth.apiKey) {
    throw new Error(`No ChatGPT OAuth token for ${model.provider}; run /login with a Codex model.`);
  }

  const tokenMetadata = getTokenMetadata(auth.apiKey);
  const headers: Record<string, string> = {
    ...(auth.headers ?? {}),
    Authorization: `Bearer ${auth.apiKey}`,
    Accept: "application/json",
    "User-Agent": "pi-rat-usage-extension",
    ...(tokenMetadata.accountId ? { "chatgpt-account-id": tokenMetadata.accountId } : {}),
  };

  const timeout = timeoutSignal(USAGE_FETCH_TIMEOUT_MS, ctx.signal);
  try {
    const response = await fetch(`${CHATGPT_BASE_URL}/wham/usage`, {
      headers,
      signal: timeout.signal,
    });

    if (!response.ok) throw new Error(`Usage endpoint returned HTTP ${response.status}.`);

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error("Usage endpoint returned invalid JSON.");
    }

    const snapshot = parseUsageSnapshot(data);
    return {
      ...snapshot,
      planType: snapshot.planType ?? tokenMetadata.planType,
      email: snapshot.email ?? tokenMetadata.email,
    };
  } catch (error) {
    if (isAbortError(error)) throw new Error("Usage request timed out or was cancelled.");
    throw error;
  } finally {
    timeout.cleanup();
  }
}

function timeoutSignal(
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);

  if (parent) {
    if (parent.aborted) abort();
    else parent.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function usageErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Usage endpoint could not be loaded.";
}
