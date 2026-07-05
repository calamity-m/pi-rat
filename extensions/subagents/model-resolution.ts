import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import type {
  SpawnSubagentInput,
  SubagentModelSelection,
  SubagentSettings,
  Tier,
} from "./types.ts";
import { THINKING_LEVELS } from "./types.ts";

export interface RegistryAdapter {
  find(provider: string, modelId: string): Model<any> | undefined;
  hasConfiguredAuth(model: Model<any>): boolean;
}

/** Resolve a model override, configured tier, or parent fallback from live registry state. */
export async function resolveSubagentModel(
  input: SpawnSubagentInput,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<SubagentModelSelection> {
  const { readSubagentSettings } = await import("./settings.ts");
  const { settings, warnings } = await readSubagentSettings();
  const selection = resolveSubagentModelCore(input, settings, ctx, pi.getThinkingLevel());
  if (warnings.length && !selection.warning) {
    return { ...selection, warning: warnings.join(" ") };
  }
  return selection;
}

/** Pure resolver core exported for tests. */
export function resolveSubagentModelCore(
  input: SpawnSubagentInput,
  settings: SubagentSettings,
  ctx: { model?: Model<any>; modelRegistry: RegistryAdapter },
  parentThinkingLevel?: string,
): SubagentModelSelection {
  if (input.model) {
    return resolveCanonicalModel(input.model, input.thinkingLevel, ctx, "raw model override");
  }

  const tier = normalizeTier(input.tier);
  if (tier === undefined || tier === "default") {
    return resolveParentModel(input.thinkingLevel, ctx, parentThinkingLevel, "tier default");
  }

  const mapping = settings.tiers[tier];
  if (!mapping) {
    return resolveParentModel(
      input.thinkingLevel,
      ctx,
      parentThinkingLevel,
      `tier ${tier} fallback: parent`,
      `No subagent model configured for tier "${tier}"; using parent model.`,
    );
  }

  try {
    return resolveCanonicalModel(
      mapping.model,
      input.thinkingLevel ?? mapping.thinkingLevel,
      ctx,
      `tier ${tier}`,
    );
  } catch (error) {
    return resolveParentModel(
      input.thinkingLevel,
      ctx,
      parentThinkingLevel,
      `tier ${tier} fallback: parent`,
      `Tier "${tier}" model ${mapping.model} is unavailable (${formatError(error)}); using parent model.`,
    );
  }
}

export function resolveCanonicalModel(
  canonicalId: string,
  thinkingLevel: string | undefined,
  ctx: { modelRegistry: RegistryAdapter },
  source: string,
): SubagentModelSelection {
  const parsed = parseCanonicalModelId(canonicalId);
  const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
  if (!model) throw new Error(`Unknown model: ${canonicalId}`);
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(
      `Model is known but unavailable; authenticate provider "${parsed.provider}" or configure its API key: ${canonicalId}`,
    );
  }
  return {
    model,
    modelId: canonicalId,
    thinkingLevel: normalizeThinkingLevel(thinkingLevel),
    source,
  };
}

export function parseCanonicalModelId(value: string): { provider: string; modelId: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1)
    throw new Error(`Invalid canonical model id: ${value}`);
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function formatCanonicalModelId(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function resolveParentModel(
  thinkingLevel: string | undefined,
  ctx: { model?: Model<any>; modelRegistry: RegistryAdapter },
  parentThinkingLevel: string | undefined,
  source: string,
  warning?: string,
): SubagentModelSelection {
  if (!ctx.model)
    throw new Error("No subagent model configured and parent session has no active model.");
  const model = ctx.modelRegistry.find(ctx.model.provider, ctx.model.id) ?? ctx.model;
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`Parent model is unavailable; authenticate provider "${model.provider}".`);
  }
  return {
    model,
    modelId: formatCanonicalModelId(model),
    thinkingLevel: normalizeThinkingLevel(thinkingLevel ?? parentThinkingLevel),
    source,
    warning,
  };
}

export function normalizeTier(value: string | undefined): Tier | undefined {
  if (value === undefined) return undefined;
  if (value === "default" || value === "fast" || value === "high") return value;
  throw new Error(`Invalid subagent tier: ${value}`);
}

export function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if ((THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
  throw new Error(`Invalid thinkingLevel: ${value}`);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
