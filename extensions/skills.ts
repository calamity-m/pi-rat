import {
  estimateTokens,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { SearchPanel } from "./lib/search-panel.ts";

/** Maximum number of skill rows visible without scrolling. */
const VISIBLE_ROWS = 12;

/** One selectable skill row with precomputed display metadata. */
interface SkillRow {
  skill: Skill;
  location: string;
  estimatedTokens: number;
  userOnly: boolean;
  searchableText: string;
}

/** Register the /skills picker command. */
export default function skillsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("skills", {
    description: "Search available skills and insert a skill invocation into the editor",
    handler: async (_args, ctx) => {
      await runSkillsPicker(ctx);
    },
  });
}

/** Open a searchable skill picker and append the selected skill invocation to the prompt. */
async function runSkillsPicker(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("skills picker requires an interactive UI", "warning");
    return;
  }

  const skills = ctx.getSystemPromptOptions().skills ?? [];
  if (skills.length === 0) {
    ctx.ui.notify("No skills available", "info");
    return;
  }

  const rows = skills.map(toSkillRow).sort((a, b) => a.skill.name.localeCompare(b.skill.name));
  const selected = await ctx.ui.custom<SkillRow | undefined>((tui, theme, keybindings, done) => {
    return new SearchPanel<SkillRow>({
      title: "skills",
      rows,
      visibleRows: VISIBLE_ROWS,
      showRowsWhenQueryEmpty: true,
      noResultsText: "No matching skills",
      footerText: "type to filter • ↑↓ navigate • enter insert skill • esc cancel",
      headerLines: [theme.fg("dim", `  ${skillHeader()}`)],
      theme,
      keybindings,
      requestRender: () => tui.requestRender(),
      filterRows,
      renderRow: (row) => skillLine(row),
      onSelect: done,
      onCancel: () => done(undefined),
    });
  });

  if (!selected) return;
  appendEditorText(ctx, `/skill:${selected.skill.name} `);
}

/** Build the searchable row metadata for one skill. */
function toSkillRow(skill: Skill): SkillRow {
  const location = skill.sourceInfo.scope === "temporary" ? "temporary" : skill.sourceInfo.scope;
  const userOnly = skill.disableModelInvocation;
  const estimatedTokens = estimateSkillTokens(skill);
  const searchableText = [
    skill.name,
    location,
    String(estimatedTokens),
    userOnly ? "yes user-only" : "no model-visible",
    skill.description,
    skill.filePath,
  ]
    .join(" ")
    .toLocaleLowerCase();

  return { skill, location, estimatedTokens, userOnly, searchableText };
}

/** Filter skills by all rendered columns. */
function filterRows(rows: readonly SkillRow[], query: string): readonly SkillRow[] {
  const normalized = query.toLocaleLowerCase();
  if (!normalized) return rows;
  return rows.filter((row) => row.searchableText.includes(normalized));
}

/** Render the fixed-width column header. */
function skillHeader(): string {
  return `${pad("name", 22)} ${pad("location", 9)} ${pad("tokens", 8)} ${pad("user only", 9)} description`;
}

/** Render one fixed-width skill row. */
function skillLine(row: SkillRow): string {
  return `${pad(row.skill.name, 22)} ${pad(row.location, 9)} ${pad(String(row.estimatedTokens), 8)} ${pad(
    row.userOnly ? "yes" : "no",
    9,
  )} ${truncate(row.skill.description, 72)}`;
}

/** Estimate the metadata tokens visible to the model before the skill body is loaded. */
function estimateSkillTokens(skill: Skill): number {
  if (skill.disableModelInvocation) return 0;
  const visibleListing = `<skill>\n<name>${skill.name}</name>\n<description>${skill.description}</description>\n<location>${skill.filePath}</location>\n</skill>`;
  return estimateTokens({ role: "user", content: visibleListing, timestamp: Date.now() });
}

/** Append text to the current editor contents with a separating space when needed. */
function appendEditorText(ctx: ExtensionCommandContext, text: string): void {
  const current = ctx.ui.getEditorText();
  const separator = current.length === 0 || /\s$/.test(current) ? "" : " ";
  ctx.ui.setEditorText(`${current}${separator}${text}`);
}

/** Pad or truncate a column value. */
function pad(value: string, width: number): string {
  const clipped = truncate(value, width);
  return `${clipped}${" ".repeat(Math.max(0, width - clipped.length))}`;
}

/** Truncate long text with trailing ellipsis. */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return ".".repeat(Math.max(0, maxLength));
  return `${value.slice(0, maxLength - 3)}...`;
}
