import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayOptions,
} from "@earendil-works/pi-tui";

/** Theme colors used by the common overlay panel. */
export type OverlayPanelColor =
  | "accent"
  | "border"
  | "dim"
  | "muted"
  | "warning"
  | "text"
  | "toolOutput";

/** Minimal Pi theme surface needed by the common overlay panel. */
export interface OverlayPanelTheme {
  fg(color: OverlayPanelColor, text: string): string;
  bold?(text: string): string;
}

/** A body entry can be raw text, pre-split lines, or any Pi TUI component. */
export type OverlayPanelContent = string | readonly string[] | Component;

/** One titled block in an overlay body. Components are rendered unchanged inside the panel. */
export interface OverlayPanelSection {
  /** Optional left-side label for the block, e.g. a tool name. */
  title?: string;
  /** Optional muted text after the title, e.g. a path or range. */
  subtitle?: string;
  /** Optional right-side label for the block, e.g. "tool". */
  badge?: string;
  /** Lines or a Pi component to render inside the block. */
  content: OverlayPanelContent;
}

/** Options for a scrollable right-side overlay panel. */
export interface OverlayPanelOptions {
  /** Title rendered into the top border. */
  title: string;
  /** Optional muted text after the title. */
  subtitle?: string;
  /** Optional right-aligned badge in the top border. */
  badge?: string;
  /** Body sections. Prefer Component content when Pi already has a renderer for it. */
  sections?: readonly OverlayPanelSection[];
  /** Convenience raw body lines used when sections are not needed. */
  lines?: readonly string[];
  /** Number of body rows to keep visible between header and footer. */
  visibleBodyRows?: number;
  /** Help text rendered in the footer after the scroll range. */
  footerText?: string;
  /** Text shown when there are no sections or lines. */
  emptyText?: string;
  /** Pi theme from ctx.ui.custom(). */
  theme: OverlayPanelTheme;
  /** Request a redraw after input-driven state changes. */
  requestRender?: () => void;
  /** Called on q/Esc. Usually this should call done() or close the overlay handle. */
  onClose?: () => void;
}

/** Default positioning for the screenshot-style right-side overlay. */
export function rightOverlayOptions(overrides: OverlayOptions = {}): OverlayOptions {
  return {
    width: "45%",
    minWidth: 72,
    maxHeight: "88%",
    anchor: "right-center",
    margin: { top: 2, right: 2, bottom: 2 },
    ...overrides,
  };
}

/** Scrollable bordered overlay shell for side panels and inspectors. */
export class OverlayPanel implements Component {
  private title: string;
  private subtitle: string | undefined;
  private badge: string | undefined;
  private sections: readonly OverlayPanelSection[];
  private lines: readonly string[];
  private scrollOffset = 0;
  private renderedBodyRows = 0;

  /** Build a reusable overlay panel. */
  constructor(private readonly options: OverlayPanelOptions) {
    this.title = options.title;
    this.subtitle = options.subtitle;
    this.badge = options.badge;
    this.sections = options.sections ?? [];
    this.lines = options.lines ?? [];
  }

  /** Replace the body sections and redraw from the nearest valid scroll offset. */
  setSections(sections: readonly OverlayPanelSection[]): void {
    this.sections = sections;
    this.lines = [];
    this.clampScroll();
    this.invalidate();
    this.options.requestRender?.();
  }

  /** Replace the raw body lines and redraw from the nearest valid scroll offset. */
  setLines(lines: readonly string[]): void {
    this.lines = lines;
    this.sections = [];
    this.clampScroll();
    this.invalidate();
    this.options.requestRender?.();
  }

  /** Update top-border labels without recreating the overlay. */
  setHeader(title: string, subtitle?: string, badge?: string): void {
    this.title = title;
    this.subtitle = subtitle;
    this.badge = badge;
    this.invalidate();
    this.options.requestRender?.();
  }

  /** Handle Vim-like scrolling plus arrow/page keys and q/Esc close. */
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") {
      this.options.onClose?.();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") return this.scrollBy(1);
    if (matchesKey(data, Key.up) || data === "k") return this.scrollBy(-1);
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
      return this.scrollBy(this.visibleBodyRows());
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
      return this.scrollBy(-this.visibleBodyRows());
    }
    if (matchesKey(data, Key.home) || data === "g") return this.scrollTo(0);
    if (matchesKey(data, Key.end) || data === "G") return this.scrollTo(Number.POSITIVE_INFINITY);
  }

  /** Render the bordered panel, a scroll window, and a persistent footer. */
  render(width: number): string[] {
    if (width <= 0) return [];
    if (width < 4) return [truncateToWidth(this.title, width, "")];

    const innerWidth = width - 4;
    const body = this.bodyLines(innerWidth);
    this.renderedBodyRows = body.length;
    this.clampScroll(body.length);

    const visibleRows = this.visibleBodyRows();
    const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + visibleRows);
    const footer = this.footerLine(body.length, width);

    return [
      this.topBorder(width),
      ...visibleBody.map((line) => this.frameLine(line, width)),
      footer,
      this.bottomBorder(width),
    ];
  }

  /** Invalidate nested Pi components. */
  invalidate(): void {
    for (const section of this.sections) {
      if (isComponent(section.content)) section.content.invalidate();
    }
  }

  private bodyLines(width: number): string[] {
    const lines = this.sections.length > 0 ? this.sectionLines(width) : [...this.lines];
    const body =
      lines.length > 0
        ? lines
        : [this.options.theme.fg("dim", this.options.emptyText ?? "No content")];
    return body.map((line) => truncateToWidth(line, width, ""));
  }

  private sectionLines(width: number): string[] {
    const out: string[] = [];
    this.sections.forEach((section, index) => {
      if (index > 0) out.push("");
      if (section.title || section.subtitle || section.badge) {
        out.push(this.sectionHeader(section, width));
      }
      out.push(...this.contentLines(section.content, width));
    });
    return out;
  }

  private contentLines(content: OverlayPanelContent, width: number): string[] {
    if (isComponent(content))
      return content.render(width).map((line) => truncateToWidth(line, width, ""));
    const lines = typeof content === "string" ? content.replace(/\n$/, "").split("\n") : content;
    return [...lines].map((line) => truncateToWidth(line, width, ""));
  }

  private sectionHeader(section: OverlayPanelSection, width: number): string {
    const left = [
      section.title ? this.options.theme.fg("accent", section.title) : undefined,
      section.subtitle ? this.options.theme.fg("muted", section.subtitle) : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    const right = section.badge ? this.options.theme.fg("dim", section.badge) : "";
    return joinLeftRight(left, right, width);
  }

  private topBorder(width: number): string {
    const available = width - 2;
    const title = this.options.theme.bold?.(this.title) ?? this.title;
    const rawLeft = ` ${title}${this.subtitle ? ` [${this.subtitle}]` : ""} `;
    const rawRight = this.badge ? ` ${this.badge} ` : "";
    const rightWidth = rawRight ? Math.min(visibleWidth(rawRight), Math.floor(available / 3)) : 0;
    const leftWidth = Math.max(0, available - rightWidth);
    const left = this.options.theme.fg("accent", truncateToWidth(rawLeft, leftWidth, ""));
    const right = rawRight
      ? this.options.theme.fg("dim", truncateToWidth(rawRight, rightWidth, ""))
      : "";
    const fill = this.border(
      "─".repeat(Math.max(0, available - visibleWidth(left) - visibleWidth(right))),
    );
    return `${this.border("╭")}${left}${fill}${right}${this.border("╮")}`;
  }

  private bottomBorder(width: number): string {
    return `${this.border("╰")}${this.border("─".repeat(Math.max(0, width - 2)))}${this.border("╯")}`;
  }

  private footerLine(totalBodyRows: number, width: number): string {
    const end = Math.min(totalBodyRows, this.scrollOffset + this.visibleBodyRows());
    const start = totalBodyRows === 0 ? 0 : this.scrollOffset + 1;
    const range = `${start}-${end}/${totalBodyRows}`;
    const marker =
      totalBodyRows > this.visibleBodyRows()
        ? this.options.theme.fg("accent", "●")
        : this.options.theme.fg("dim", "○");
    const help = this.options.footerText ?? "j/k scroll | g/G top/end | q close";
    return this.frameLine(
      `${this.options.theme.fg("dim", range)} ${marker} ${this.options.theme.fg("dim", "│")} ${this.options.theme.fg("dim", help)}`,
      width,
    );
  }

  private frameLine(text: string, width: number): string {
    const innerWidth = Math.max(0, width - 4);
    const clipped = truncateToWidth(text, innerWidth, "");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    return `${this.border("│ ")}${clipped}${padding}${this.border(" │")}`;
  }

  private border(text: string): string {
    return this.options.theme.fg("border", text);
  }

  private visibleBodyRows(): number {
    return Math.max(1, this.options.visibleBodyRows ?? 28);
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.scrollOffset + delta);
  }

  private scrollTo(offset: number): void {
    const next = this.clampedScroll(offset);
    if (next === this.scrollOffset) return;
    this.scrollOffset = next;
    this.options.requestRender?.();
  }

  private clampScroll(totalRows?: number): void {
    this.scrollOffset = this.clampedScroll(this.scrollOffset, totalRows);
  }

  private clampedScroll(offset: number, totalRows?: number): number {
    const maxScroll = Math.max(0, (totalRows ?? this.renderedBodyRows) - this.visibleBodyRows());
    return Math.max(0, Math.min(maxScroll, offset));
  }
}

function isComponent(value: OverlayPanelContent): value is Component {
  return typeof value === "object" && value !== null && "render" in value && "invalidate" in value;
}

function joinLeftRight(left: string, right: string, width: number): string {
  if (!right) return truncateToWidth(left, width, "");
  const gap = 1;
  const rightWidth = Math.min(visibleWidth(right), Math.max(0, Math.floor(width / 3)));
  const clippedRight = truncateToWidth(right, rightWidth, "");
  const leftWidth = Math.max(0, width - visibleWidth(clippedRight) - gap);
  const clippedLeft = truncateToWidth(left, leftWidth, "");
  const padding = " ".repeat(
    Math.max(gap, width - visibleWidth(clippedLeft) - visibleWidth(clippedRight)),
  );
  return `${clippedLeft}${padding}${clippedRight}`;
}
