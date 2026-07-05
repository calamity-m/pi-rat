import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { AppliedPresetInput, SpawnSubagentInput } from "./types.ts";
import { MAX_PRELOADED_FILE_CHARS, MAX_PRELOADED_TOTAL_CHARS } from "./types.ts";
import type { PresetAgent } from "./preset-agents.ts";

/** Return markdown preset metadata as one description suffix for tool registration. */
export function formatPresetGuidance(presets: Map<string, PresetAgent>): string {
  if (presets.size === 0) return "";
  const lines = [...presets.values()].map(
    (preset) => `\n- ${preset.name}: ${preset.description ?? "No description provided."}`,
  );
  return `\n\nAvailable preset agents:${lines.join("")}`;
}

/** Merge a named preset with explicit tool-call params, preserving explicit precedence. */
export function applyPresetAgent(
  params: SpawnSubagentInput,
  presets: Map<string, PresetAgent>,
): AppliedPresetInput {
  if (!params.agent) return params;
  const preset = presets.get(params.agent);
  if (!preset) {
    const available = [...presets.keys()].sort().join(", ") || "none";
    throw new Error(
      `Unknown preset agent "${params.agent}". Available preset agents: ${available}.`,
    );
  }
  const presetTier = preset.tier === "any" ? undefined : preset.tier;
  return {
    ...params,
    tier: params.tier ?? presetTier,
    tools: params.tools ?? preset.tools,
    outputFormat: params.outputFormat ?? preset.outputFormat,
    role: [preset.body, params.role].filter(Boolean).join("\n\n") || undefined,
    presetAgentName: preset.name,
    presetAgentSource: preset.sourcePath,
  };
}

/** Build the isolated subagent prompt from structured inputs and preloaded file blocks. */
export function buildSubagentPrompt(input: SpawnSubagentInput, preloadedFiles: string[]): string {
  const parts = [
    "You are an isolated ephemeral subagent spawned by a parent Pi session.",
    "Work independently. Do not assume access to the parent conversation beyond the context below.",
    "Return a concise final answer for the parent agent. Do not mention hidden chain-of-thought.",
  ];
  if (input.role) parts.push(`\nRole:\n${input.role}`);
  if (input.context) parts.push(`\nContext:\n${input.context}`);
  if (preloadedFiles.length) parts.push(`\nPreloaded files:\n${preloadedFiles.join("\n\n")}`);
  if (input.files?.length)
    parts.push(`\nRelevant file paths:\n${input.files.map((file) => `- ${file}`).join("\n")}`);
  if (input.outputFormat) parts.push(`\nOutput format:\n${input.outputFormat}`);
  parts.push(`\nTask:\n${input.task}`);
  return parts.join("\n");
}

/** Read bounded file snippets for prompt preloading, reporting failures as prompt text. */
export async function preloadFiles(cwd: string, files: string[] | undefined): Promise<string[]> {
  if (!files?.length) return [];
  let total = 0;
  const blocks: string[] = [];
  for (const rawFile of files) {
    const file = rawFile.replace(/^@+/, "");
    const path = isAbsolute(file) ? file : resolve(cwd, file);
    try {
      const raw = await readFile(path, "utf8");
      const remaining = Math.max(0, MAX_PRELOADED_TOTAL_CHARS - total);
      const content = raw.slice(0, Math.min(MAX_PRELOADED_FILE_CHARS, remaining));
      total += content.length;
      const truncated =
        content.length < raw.length
          ? `\n[truncated: ${raw.length - content.length} chars omitted]`
          : "";
      blocks.push(`### ${file}\n\`\`\`\n${content}${truncated}\n\`\`\``);
      if (total >= MAX_PRELOADED_TOTAL_CHARS) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      blocks.push(`### ${file}\n[Could not preload file: ${message}]`);
    }
  }
  return blocks;
}

/** Extract the last assistant text message from nested-session `agent_end` messages. */
export function extractFinalAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    return message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          Boolean(part) &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}
