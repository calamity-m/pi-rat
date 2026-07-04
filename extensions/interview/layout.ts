import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Pad a string with spaces until its visible width reaches the target width. */
export function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Render two columns with a small gap while respecting terminal display width. */
export function sideBySide(left: string[], right: string[], width: number): string[] {
  const gap = 2;
  const rightWidth = Math.min(Math.floor(width * 0.45), Math.max(30, width - 40));
  const leftWidth = Math.max(20, width - rightWidth - gap);
  const rows = Math.max(left.length, right.length);
  return Array.from({ length: rows }, (_, i) => {
    const leftLine = truncateToWidth(left[i] ?? "", leftWidth, "");
    const rightLine = truncateToWidth(right[i] ?? "", rightWidth, "");
    return `${padToWidth(leftLine, leftWidth)}${" ".repeat(gap)}${rightLine}`;
  });
}

/** Wrap a custom-answer row while keeping the prompt visible on the first line only. */
export function wrapCustomAnswer(prefix: string, value: string, width: number): string[] {
  if (!value) return [prefix];
  const lines: string[] = [];
  let linePrefix = `${prefix}: `;
  let remaining = value;

  while (remaining.length > 0) {
    const available = Math.max(8, width - visibleWidth(linePrefix));
    let chunk = remaining.slice(0, available);
    if (remaining.length > available) {
      const breakAt = Math.max(chunk.lastIndexOf(" "), chunk.lastIndexOf("\t"));
      if (breakAt > 0) chunk = chunk.slice(0, breakAt);
    }
    lines.push(`${linePrefix}${chunk}`);
    remaining = remaining.slice(chunk.length).replace(/^\s+/, "");
    linePrefix = "   ";
  }

  return lines;
}
