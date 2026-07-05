import {
  estimateTokens,
  type BuildSystemPromptOptions,
  type Skill,
} from "@earendil-works/pi-coding-agent";

export type SystemPromptSectionId = "compiled" | "tools" | "skills" | "context-files";

export interface SystemPromptSection {
  id: SystemPromptSectionId;
  label: string;
  description: string;
  lines: string[];
}

interface CountedItem {
  name: string;
  description: string;
  tokens: number;
  bodyLines?: readonly string[];
}

/** Build the /usage System Prompt leaf data from the active prompt and prompt options. */
export function buildSystemPromptSections(
  compiledSystemPrompt: string,
  options: BuildSystemPromptOptions,
): readonly SystemPromptSection[] {
  const compiledTokens = estimateTextTokens(compiledSystemPrompt);
  const tools = getVisibleToolItems(options);
  const skills = getVisibleSkillItems(options.skills ?? []);
  const contextFiles = getContextFileItems(options.contextFiles ?? []);

  return [
    {
      id: "compiled",
      label: "Compiled System Prompt",
      description: `${compiledTokens} estimated tokens`,
      lines: buildDocumentLines("Compiled System Prompt", [
        `estimated tokens: ${compiledTokens}`,
        `characters: ${compiledSystemPrompt.length}`,
      ], compiledSystemPrompt),
    },
    {
      id: "tools",
      label: "Tools",
      description: itemCountDescription(tools.length, "tool"),
      lines: buildCountedItemLines("Tools", tools, "No model-visible tools found."),
    },
    {
      id: "skills",
      label: "Skills",
      description: itemCountDescription(skills.length, "skill"),
      lines: buildCountedItemLines("Skills", skills, "No model-visible skills found."),
    },
    {
      id: "context-files",
      label: "Context Files",
      description: itemCountDescription(contextFiles.length, "context file"),
      lines: buildCountedItemLines(
        "Context Files",
        contextFiles,
        "No context files loaded.",
      ),
    },
  ];
}

function getVisibleToolItems(options: BuildSystemPromptOptions): CountedItem[] {
  const toolSnippets = options.toolSnippets ?? {};
  const toolNames = options.selectedTools ?? ["read", "bash", "edit", "write"];

  return toolNames
    .filter((name) => Boolean(toolSnippets[name]))
    .map((name) => {
      const promptLine = `- ${name}: ${toolSnippets[name]}`;
      return {
        name,
        description: toolSnippets[name],
        tokens: estimateTextTokens(promptLine),
      };
    });
}

function getVisibleSkillItems(skills: readonly Skill[]): CountedItem[] {
  return skills
    .filter((skill) => !skill.disableModelInvocation)
    .map((skill) => {
      const visibleListing = skillPromptListing(skill);
      return {
        name: skill.name,
        description: skill.description,
        tokens: estimateTextTokens(visibleListing),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getContextFileItems(
  contextFiles: readonly NonNullable<BuildSystemPromptOptions["contextFiles"]>[number][],
): CountedItem[] {
  return contextFiles.map((file) => {
    const promptListing = `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`;
    return {
      name: file.path,
      description: `${file.content.length} chars`,
      tokens: estimateTextTokens(promptListing),
      bodyLines: formatBodyLines(file.content),
    };
  });
}

function skillPromptListing(skill: Skill): string {
  return `<skill>\n<name>${skill.name}</name>\n<description>${skill.description}</description>\n<location>${skill.filePath}</location>\n</skill>`;
}

function buildCountedItemLines(
  title: string,
  items: readonly CountedItem[],
  emptyMessage: string,
): string[] {
  const total = items.reduce((sum, item) => sum + item.tokens, 0);
  const lines = sectionHeader(title, [`estimated tokens: ${total}`, `items: ${items.length}`]);

  if (items.length === 0) {
    lines.push(emptyMessage);
    return lines;
  }

  for (const [index, item] of items.entries()) {
    if (index > 0) lines.push("");
    lines.push(`${item.name} — ${item.tokens} tokens`);
    if (item.description) lines.push(`  ${item.description}`);
    if (item.bodyLines && item.bodyLines.length > 0) {
      lines.push("  content:");
      lines.push(...item.bodyLines.map((line) => `  ${line}`));
    }
  }

  return lines;
}

function buildDocumentLines(title: string, metadata: readonly string[], content: string): string[] {
  const lines = sectionHeader(title, metadata);
  if (!content) {
    lines.push("(empty)");
    return lines;
  }
  lines.push(...formatBodyLines(content));
  return lines;
}

function sectionHeader(title: string, metadata: readonly string[]): string[] {
  return [title, "─".repeat(title.length), ...metadata, ""];
}

function formatBodyLines(content: string): string[] {
  return content.replace(/\n$/, "").split("\n").map((line) => (line ? `│ ${line}` : "│"));
}

function itemCountDescription(count: number, singular: string): string {
  const noun = count === 1 ? singular : `${singular}s`;
  return `${count} ${noun}`;
}

function estimateTextTokens(content: string): number {
  return estimateTokens({ role: "user", content, timestamp: 0 });
}
