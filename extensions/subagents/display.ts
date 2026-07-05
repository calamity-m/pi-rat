const PRELOADED_FILES_HEADER = "Preloaded files:";
const FOLLOWING_SECTION_PATTERN = /^([A-Z][A-Za-z ]+):$/;

/** Hide generated preloaded file bodies from subagent transcript display only. */
export function compactDisplayedSubagentPrompt(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === PRELOADED_FILES_HEADER);
  if (start < 0) return text;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (FOLLOWING_SECTION_PATTERN.test(lines[i]?.trim() ?? "")) {
      end = i;
      break;
    }
  }

  const replacement = `${PRELOADED_FILES_HEADER}\n[omitted from overlay; see Relevant file paths below]`;
  return [...lines.slice(0, start), replacement, ...lines.slice(end)].join("\n");
}
