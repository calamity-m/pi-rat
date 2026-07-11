import { readdirSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Register Markdown prompt templates nested below the global prompts directory. */
export default function nestedPrompts(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({
    promptPaths: findNestedPromptFiles(join(getAgentDir(), "prompts")),
  }));
}

export function findNestedPromptFiles(promptsDir: string): string[] {
  const promptPaths: string[] = [];

  let entries;
  try {
    entries = readdirSync(promptsDir, { withFileTypes: true });
  } catch {
    return promptPaths;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    collectPromptFiles(join(promptsDir, entry.name), promptPaths);
  }

  return promptPaths.sort();
}

function collectPromptFiles(directory: string, promptPaths: string[]): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) collectPromptFiles(entryPath, promptPaths);
    else if (entry.isFile() && entry.name.endsWith(".md")) promptPaths.push(entryPath);
  }
}

export const __nestedPromptsForTest = { findNestedPromptFiles };
