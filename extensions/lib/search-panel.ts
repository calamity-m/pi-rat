import {
  Container,
  type Focusable,
  Input,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

/** Minimal keybinding matcher used by reusable TUI panels. */
export interface PanelKeybindings {
  matches(data: string, id: string): boolean;
}

/** Minimal theme surface needed by search panels. */
export interface SearchPanelTheme {
  fg(color: string, text: string): string;
}

/** Color function for search panel frame lines. */
export type SearchPanelBorderColor = (text: string) => string;

/** Shared panel chrome renderer for titled panels with no side borders. */
export class PanelChrome {
  private readonly theme: SearchPanelTheme;
  private readonly borderColor: SearchPanelBorderColor;

  /** Build a panel chrome renderer using the provided color theme. */
  constructor(theme: SearchPanelTheme, borderColor?: SearchPanelBorderColor) {
    this.theme = theme;
    this.borderColor = borderColor ?? ((text) => theme.fg("border", text));
  }

  /** Render edge-to-edge rules, a visible title row, and padded content rows. */
  render(title: string, width: number, lines: string[]): string[] {
    if (width < 1) return [""];

    return [
      this.horizontalRule(width),
      this.frameLine(this.theme.fg("accent", title), width),
      ...lines.map((line) => this.frameLine(line, width)),
      this.horizontalRule(width),
    ];
  }

  /** Render an edge-to-edge horizontal rule. */
  horizontalRule(width: number): string {
    return this.borderColor("─".repeat(Math.max(0, width)));
  }

  /** Render one content line with right padding and no side borders. */
  frameLine(text: string, contentWidth: number): string {
    const clipped = truncateToWidth(text, contentWidth, "");
    const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
    return `${clipped}${pad}`;
  }
}

/** Context passed to row renderers. */
export interface SearchPanelRowContext {
  /** Current search query after trimming whitespace. */
  query: string;
  /** Absolute row index in the filtered result set. */
  index: number;
  /** Available row width excluding the selection prefix. */
  width: number;
  /** Whether this row is currently selected. */
  selected: boolean;
}

/** Options for a reusable searchable, selectable row panel. */
export interface SearchPanelOptions<T> {
  /** Panel title rendered above the input and result rows. */
  title: string;
  /** Initial source rows searched by the panel. */
  rows: readonly T[];
  /** Initial text for the search input. */
  initialQuery?: string;
  /** Maximum number of rows visible at one time. */
  visibleRows?: number;
  /** Whether to show filtered rows before the user types a search query. */
  showRowsWhenQueryEmpty?: boolean;
  /** Static lines rendered above the row list, for headers or hints. */
  headerLines?: string[];
  /** Text shown before the user types a search query. */
  emptyQueryText?: string;
  /** Text shown when the query has no matching rows. */
  noResultsText?: string;
  /** Footer help text. */
  footerText?: string;
  /** Theme from Pi's custom UI factory. */
  theme: SearchPanelTheme;
  /** Keybindings from Pi's custom UI factory. */
  keybindings: PanelKeybindings;
  /** Request a TUI render after state changes. */
  requestRender: () => void;
  /** Optional frame color. Defaults to the prompt border color. */
  borderColor?: SearchPanelBorderColor;
  /** Convert source rows and the current query into display rows. */
  filterRows: (rows: readonly T[], query: string) => readonly T[];
  /** Render one row label. Selection prefix and clipping are handled by the panel. */
  renderRow: (row: T, context: SearchPanelRowContext) => string;
  /** Called when the selected row is confirmed with Enter. */
  onSelect: (row: T) => void;
  /** Called when the user cancels the panel. */
  onCancel: () => void;
}

/** Search input plus a scrollable, selectable list of filtered rows. */
export class SearchPanel<T> extends Container implements Focusable {
  private readonly input: Input;
  private rows: readonly T[];
  private filteredRows: readonly T[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private focusedValue = false;
  private readonly chrome: PanelChrome;
  private readonly options: Omit<SearchPanelOptions<T>, "rows">;

  /** Create a searchable panel over the provided rows. */
  constructor(options: SearchPanelOptions<T>) {
    super();
    this.rows = options.rows;
    this.options = options;
    this.chrome = new PanelChrome(options.theme, options.borderColor);
    this.input = new Input();
    this.input.setValue(options.initialQuery ?? "");
    this.addChild(this.input);
    this.refreshRows();
  }

  /** Replace the searched rows, usually after async loading finishes. */
  setRows(rows: readonly T[]): void {
    this.rows = rows;
    this.refreshRows();
    this.options.requestRender();
  }

  /** Propagate focus to the embedded input so terminal IME/cursor placement works. */
  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.input.focused = value;
  }

  /** Render the search box, visible result window, and compact key help inside chrome. */
  render(width: number): string[] {
    const contentWidth = width;
    const query = this.query();
    const lines = this.input.render(Math.max(1, contentWidth));

    if (this.options.headerLines) lines.push(...this.options.headerLines);

    if (!query && !this.options.showRowsWhenQueryEmpty) {
      lines.push(this.options.theme.fg("dim", this.options.emptyQueryText ?? "Type to search…"));
    } else if (this.filteredRows.length === 0) {
      lines.push(
        this.options.theme.fg("warning", this.options.noResultsText ?? "No matching rows"),
      );
    } else {
      for (const { row, index } of this.visibleWindow()) {
        lines.push(this.renderResult(row, index, contentWidth));
      }
    }

    lines.push(
      this.options.theme.fg(
        "dim",
        this.options.footerText ?? "↑↓ navigate • enter select • esc cancel",
      ),
    );
    return this.chrome.render(this.options.title, width, lines);
  }

  /** Route navigation keys to rows and all other text editing to the input. */
  handleInput(data: string): void {
    if (this.options.keybindings.matches(data, "tui.select.cancel")) {
      this.options.onCancel();
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.filteredRows[this.selectedIndex];
      if (selected !== undefined) this.options.onSelect(selected);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }

    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) this.refreshRows();
    this.options.requestRender();
  }

  /** Clear cached child render state. */
  invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  /** Current query after trimming whitespace. */
  private query(): string {
    return this.input.getValue().trim();
  }

  /** Move the selected row, wrapping over the full filtered set. */
  private moveSelection(delta: number): void {
    if (this.filteredRows.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex + delta + this.filteredRows.length) % this.filteredRows.length;
    this.keepSelectionVisible();
    this.options.requestRender();
  }

  /** Recompute filtered rows for the current input value. */
  private refreshRows(): void {
    const query = this.query();
    this.filteredRows =
      query || this.options.showRowsWhenQueryEmpty ? this.options.filterRows(this.rows, query) : [];
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  /** Clamp the scroll offset so the selected row is visible. */
  private keepSelectionVisible(): void {
    const visibleRows = this.visibleRows();
    if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
    if (this.selectedIndex >= this.scrollOffset + visibleRows) {
      this.scrollOffset = this.selectedIndex - visibleRows + 1;
    }
  }

  /** Number of result rows visible at once. */
  private visibleRows(): number {
    return Math.max(1, this.options.visibleRows ?? 10);
  }

  /** Current window of rows to render from the full filtered row set. */
  private visibleWindow(): Array<{ row: T; index: number }> {
    const start = Math.max(0, Math.min(this.scrollOffset, this.filteredRows.length - 1));
    const end = Math.min(this.filteredRows.length, start + this.visibleRows());
    const out: Array<{ row: T; index: number }> = [];
    for (let index = start; index < end; index++) {
      const row = this.filteredRows[index];
      if (row !== undefined) out.push({ row, index });
    }
    return out;
  }

  /** Render one row with prefix, truncation, and selected styling. */
  private renderResult(row: T, index: number, width: number): string {
    const selected = index === this.selectedIndex;
    const prefix = selected ? "→ " : "  ";
    const label = this.options.renderRow(row, {
      query: this.query(),
      index,
      width: Math.max(1, width - prefix.length),
      selected,
    });
    const clipped = truncateToWidth(label, Math.max(1, width - prefix.length), "");
    const line = `${prefix}${clipped}`;
    return selected ? this.options.theme.fg("accent", line) : line;
  }
}
