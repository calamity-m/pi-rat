import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";

export const TOOL_POLICIES = ["none", "read-only", "coding"] as const;
export const TIERS = ["default", "fast", "high"] as const;
export const SETTING_TIERS = ["fast", "high"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const MAX_RECORDED_RUNS = 20;
export const MAX_PRELOADED_FILE_CHARS = 20_000;
export const MAX_PRELOADED_TOTAL_CHARS = 60_000;

export const toolPolicyNames = {
  none: [],
  "read-only": ["read", "grep", "find", "ls"],
  coding: ["read", "grep", "find", "ls", "bash", "edit", "write"],
} satisfies Record<ToolPolicy, string[]>;

export const spawnSubagentSchema = Type.Object({
  agent: Type.Optional(
    Type.String({ description: "Optional named preset agent to use before explicit overrides." }),
  ),
  task: Type.String({ description: "The isolated subagent task to run." }),
  tier: Type.Optional(
    StringEnum(TIERS, { description: "Subagent tier to use; default follows the parent model." }),
  ),
  model: Type.Optional(
    Type.String({ description: "Raw canonical model override, provider/model-id." }),
  ),
  thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS)),
  role: Type.Optional(Type.String({ description: "Optional role/persona for the subagent." })),
  context: Type.Optional(Type.String({ description: "Extra context to provide to the subagent." })),
  files: Type.Optional(
    Type.Array(Type.String(), { description: "Relevant file paths to preload into the prompt." }),
  ),
  tools: Type.Optional(
    StringEnum(TOOL_POLICIES, { description: "Tool access policy. Defaults to read-only." }),
  ),
  outputFormat: Type.Optional(Type.String({ description: "Requested final answer format." })),
}) satisfies TSchema;

export type SpawnSubagentInput = Static<typeof spawnSubagentSchema>;
export type ToolPolicy = (typeof TOOL_POLICIES)[number];
export type Tier = (typeof TIERS)[number];
export type SettingTier = (typeof SETTING_TIERS)[number];
export type SubagentRunStatus = "queued" | "running" | "done" | "error" | "aborted";

export interface AppliedPresetInput extends SpawnSubagentInput {
  presetAgentName?: string;
  presetAgentSource?: string;
}

export interface SubagentProxyReadinessHook {
  ensure(ctx: ExtensionContext): Promise<void> | void;
}

export interface RegisterSubagentsOptions {
  proxy?: SubagentProxyReadinessHook;
}

export interface SubagentsController {
  statusLabel(): string | undefined;
}

export interface SubagentTierMapping {
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export interface SubagentSettings {
  tiers: Partial<Record<SettingTier, SubagentTierMapping>>;
}

export interface SubagentSettingsReadResult {
  settings: SubagentSettings;
  warnings: string[];
}

export interface SubagentRun {
  id: string;
  task: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  modelSource: string;
  modelResolutionWarning?: string;
  tools: ToolPolicy;
  presetAgentName?: string;
  presetAgentSource?: string;
  status: SubagentRunStatus;
  currentActivity: string;
  finalText?: string;
  transcript?: unknown[];
  events?: AgentSessionEvent[];
  error?: string;
  startedAt: number;
  endedAt?: number;
  cancel?: (notes?: string) => void;
  cancelNotes?: string;
}

export interface SubagentModelSelection {
  model: Model<any>;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  source: string;
  warning?: string;
}

export type SubagentStoreListener = () => void;
export type { AgentSessionEvent };
