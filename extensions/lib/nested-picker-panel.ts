import {
  Container,
  Input,
  Key,
  isFocusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

/** Minimal keybinding matcher used by reusable TUI panels. */
export interface PanelKeybindings {
  matches(data: string, id: string): boolean;
}

/** Minimal theme surface needed by nested picker panels. */
export interface NestedPickerPanelTheme {
  fg(color: string, text: string): string;
}

/** Content shown after a terminal row is confirmed. */
export type NestedPickerContent = string | readonly string[] | Component;

/** One row in a static nested picker tree. */
export interface NestedPickerRow<TValue = unknown> {
  /** Stable row identifier, unique among siblings and used for per-level state. */
  id: string;
  /** Human-readable row label rendered in the picker. */
  label: string;
  /** Optional secondary text searched and rendered by the default row renderer. */
  description?: string;
  /** Optional caller-owned value associated with this row. */
  value?: TValue;
  /** Static child rows. Rows without children are terminal leaves. */
  children?: readonly NestedPickerRow<TValue>[];
}

/** Context passed to the leaf content renderer. */
export interface NestedPickerContentContext<TValue = unknown> {
  /** Terminal row that was confirmed. */
  row: NestedPickerRow<TValue>;
  /** Full selected path, including `row` as the last segment. */
  path: readonly NestedPickerRow<TValue>[];
  /** Available content width in terminal columns. */
  width: number;
}

/** Context passed to row renderers. */
export interface NestedPickerRowContext<TValue = unknown> {
  /** Current search query after trimming whitespace. */
  query: string;
  /** Branch path for the level currently being rendered. */
  path: readonly NestedPickerRow<TValue>[];
  /** Absolute row index in the filtered result set. */
  index: number;
  /** Available row width excluding the selection prefix. */
  width: number;
  /** Whether this row is currently selected. */
  selected: boolean;
  /** Zero-based nesting depth for the current level. */
  depth: number;
  /** Whether this row descends to another picker level. */
  hasChildren: boolean;
}

/** Options for a reusable arbitrary-depth static tree picker.
 *
 * Keyboard behavior: Up/Down move the selected row, Enter descends into branch
 * rows or opens renderer-produced content for leaf rows, Left/Backspace return
 * to the parent level, and Esc jumps to root before cancelling from root.
 * Active leaf components receive keys that the picker does not reserve for
 * navigation or cancel handling.
 */
export interface NestedPickerPanelOptions<TValue = unknown> {
  /** Panel title rendered above the breadcrumb and rows. */
  title: string;
  /** Root rows for the static picker tree. */
  rows: readonly NestedPickerRow<TValue>[];
  /** Whether to show a per-level search input above picker rows. */
  enableSearch?: boolean;
  /** Maximum number of rows visible at one time. */
  visibleRows?: number;
  /** Theme from Pi's custom UI factory. */
  theme: NestedPickerPanelTheme;
  /** Keybindings from Pi's custom UI factory. */
  keybindings: PanelKeybindings;
  /** Request a TUI render after state changes. */
  requestRender: () => void;
  /** Build content for a terminal row after Enter is pressed. */
  renderContent: (context: NestedPickerContentContext<TValue>) => NestedPickerContent;
  /** Optional search implementation. Defaults to case-insensitive label/description matching. */
  filterRows?: (
    rows: readonly NestedPickerRow<TValue>[],
    query: string,
    path: readonly NestedPickerRow<TValue>[],
  ) => readonly NestedPickerRow<TValue>[];
  /** Optional row renderer. Selection prefix and clipping are handled by the panel. */
  renderRow?: (row: NestedPickerRow<TValue>, context: NestedPickerRowContext<TValue>) => string;
  /** Called when Enter opens a terminal row. */
  onLeafEnter?: (row: NestedPickerRow<TValue>, path: readonly NestedPickerRow<TValue>[]) => void;
  /** Called when Esc is pressed while already at the root picker level. */
  onCancel: () => void;
}

interface LevelState {
  selectedIndex: number;
  scrollOffset: number;
  query: string;
}

/** Searchable nested picker over a caller-supplied static row tree. */
export class NestedPickerPanel<TValue = unknown> extends Container implements Focusable {
  private readonly input: Input | undefined;
  private readonly chrome: NestedPickerChrome;
  private readonly levelStates = new Map<string, LevelState>();
  private path: NestedPickerRow<TValue>[] = [];
  private activeLeaf: NestedPickerRow<TValue> | undefined;
  private activeContent: NestedPickerContent | undefined;
  private focusedValue = false;
  private lastRenderWidth = 80;

  /** Create a nested picker panel with optional per-level search. */
  constructor(private readonly options: NestedPickerPanelOptions<TValue>) {
    super();
    this.chrome = new NestedPickerChrome(options.theme);
    if (options.enableSearch) {
      this.input = new Input();
      this.addChild(this.input);
    }
    this.levelState(this.path);
    this.syncInputToLevel();
  }

  /** Propagate focus to the visible input, or an active focusable content component. */
  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.applyFocus();
  }

  /** Render breadcrumb, optional search, rows or leaf content, and compact key help. */
  render(width: number): string[] {
    if (width < 1) return [""];

    this.lastRenderWidth = width;
    const lines = [this.breadcrumbLine()];

    if (this.activeLeaf) {
      lines.push(...this.contentLines(width));
      lines.push(this.options.theme.fg("dim", "←/backspace parent • esc root/cancel"));
    } else {
      this.syncInputToLevel();
      if (this.input) lines.push(...this.input.render(Math.max(1, width)));
      lines.push(...this.rowLines(width));
      lines.push(
        this.options.theme.fg(
          "dim",
          "↑↓ navigate • enter open/select • ← parent • esc root/cancel",
        ),
      );
    }

    return this.chrome.render(this.options.title, width, lines);
  }

  /** Handle picker navigation, search editing, cancellation, and active leaf delegation. */
  handleInput(data: string): void {
    if (this.options.keybindings.matches(data, "tui.select.cancel")) {
      if (this.isRootPicker()) this.options.onCancel();
      else this.goRoot();
      return;
    }

    if (this.isParentKey(data)) {
      this.goParent();
      return;
    }

    if (this.activeLeaf) {
      if (isComponent(this.activeContent) && this.activeContent.handleInput) {
        this.activeContent.handleInput(data);
        this.options.requestRender();
      }
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
    if (this.options.keybindings.matches(data, "tui.select.confirm")) {
      this.confirmSelection();
      return;
    }

    if (!this.input) return;
    const before = this.input.getValue();
    this.input.handleInput(data);
    const after = this.input.getValue();
    if (after !== before) {
      const state = this.currentLevelState();
      state.query = after;
      state.selectedIndex = 0;
      state.scrollOffset = 0;
      this.options.requestRender();
    }
  }

  /** Clear cached child render state. */
  invalidate(): void {
    super.invalidate();
    this.input?.invalidate();
    if (isComponent(this.activeContent)) this.activeContent.invalidate();
  }

  private rowLines(width: number): string[] {
    const rows = this.filteredRows();
    const state = this.currentLevelState();
    this.clampSelection(state, rows.length);
    this.keepSelectionVisible(state, rows.length);

    if (rows.length === 0) {
      const emptyText = this.query() ? "No matching rows" : "No rows";
      return [this.options.theme.fg(this.query() ? "warning" : "dim", emptyText)];
    }

    const out: string[] = [];
    const start = Math.max(0, Math.min(state.scrollOffset, rows.length - 1));
    const end = Math.min(rows.length, start + this.visibleRows());
    for (let index = start; index < end; index++) {
      const row = rows[index];
      if (row) out.push(this.renderRow(row, index, width));
    }
    return out;
  }

  private renderRow(row: NestedPickerRow<TValue>, index: number, width: number): string {
    const state = this.currentLevelState();
    const selected = index === state.selectedIndex;
    const prefix = selected ? "→ " : "  ";
    const label = this.rowLabel(row, {
      query: this.query(),
      path: this.path,
      index,
      width: Math.max(1, width - prefix.length),
      selected,
      depth: this.path.length,
      hasChildren: hasChildren(row),
    });
    const clipped = truncateToWidth(label, Math.max(1, width - prefix.length), "");
    const line = `${prefix}${clipped}`;
    return selected ? this.options.theme.fg("accent", line) : line;
  }

  private rowLabel(row: NestedPickerRow<TValue>, context: NestedPickerRowContext<TValue>): string {
    if (this.options.renderRow) return this.options.renderRow(row, context);
    const marker = context.hasChildren ? "› " : "  ";
    const description = row.description ? ` — ${row.description}` : "";
    return `${marker}${row.label}${description}`;
  }

  private contentLines(width: number): string[] {
    const content = this.ensureActiveContent(width);
    if (isComponent(content)) {
      return content.render(width).map((line) => truncateToWidth(line, width, ""));
    }
    const lines = typeof content === "string" ? content.replace(/\n$/, "").split("\n") : content;
    return [...lines].map((line) => truncateToWidth(line, width, ""));
  }

  private ensureActiveContent(width: number): NestedPickerContent {
    if (!this.activeLeaf) return "";
    if (this.activeContent === undefined) {
      this.activeContent = this.options.renderContent({
        row: this.activeLeaf,
        path: this.fullActivePath(),
        width,
      });
      this.applyFocus();
    }
    return this.activeContent;
  }

  private breadcrumbLine(): string {
    const rows = this.fullActivePath();
    const names = rows.length === 0 ? ["root"] : rows.map((row) => row.label);
    const lastIndex = names.length - 1;
    const rendered = names.map((name, index) =>
      index === lastIndex ? this.options.theme.fg("accent", name) : name,
    );
    return `Path: ${rendered.join(" -> ")}`;
  }

  private confirmSelection(): void {
    const rows = this.filteredRows();
    const selected = rows[this.currentLevelState().selectedIndex];
    if (!selected) return;

    if (hasChildren(selected)) {
      this.path = [...this.path, selected];
      this.activeLeaf = undefined;
      this.activeContent = undefined;
      this.levelState(this.path);
      this.syncInputToLevel();
      this.applyFocus();
      this.options.requestRender();
      return;
    }

    const fullPath = [...this.path, selected];
    this.options.onLeafEnter?.(selected, fullPath);
    this.activeLeaf = selected;
    this.activeContent = this.options.renderContent({
      row: selected,
      path: fullPath,
      width: this.lastRenderWidth,
    });
    this.applyFocus();
    this.options.requestRender();
  }

  private moveSelection(delta: number): void {
    const rows = this.filteredRows();
    if (rows.length === 0) return;
    const state = this.currentLevelState();
    state.selectedIndex = (state.selectedIndex + delta + rows.length) % rows.length;
    this.keepSelectionVisible(state, rows.length);
    this.options.requestRender();
  }

  private goParent(): void {
    if (this.activeLeaf) {
      this.activeLeaf = undefined;
      this.activeContent = undefined;
      this.syncInputToLevel();
      this.applyFocus();
      this.options.requestRender();
      return;
    }
    if (this.path.length === 0) return;
    this.path = this.path.slice(0, -1);
    this.syncInputToLevel();
    this.applyFocus();
    this.options.requestRender();
  }

  private goRoot(): void {
    if (this.isRootPicker()) return;
    this.path = [];
    this.activeLeaf = undefined;
    this.activeContent = undefined;
    this.syncInputToLevel();
    this.applyFocus();
    this.options.requestRender();
  }

  private isRootPicker(): boolean {
    return this.path.length === 0 && this.activeLeaf === undefined;
  }

  private isParentKey(data: string): boolean {
    return matchesKey(data, Key.left) || matchesKey(data, Key.backspace);
  }

  private filteredRows(): readonly NestedPickerRow<TValue>[] {
    const rows = this.currentRows();
    const query = this.query();
    if (!this.input || !query) return rows;
    return (this.options.filterRows ?? defaultFilterRows)(rows, query, this.path);
  }

  private currentRows(): readonly NestedPickerRow<TValue>[] {
    return this.path.length === 0
      ? this.options.rows
      : (this.path[this.path.length - 1]?.children ?? []);
  }

  private query(): string {
    return this.input ? this.currentLevelState().query.trim() : "";
  }

  private currentLevelState(): LevelState {
    return this.levelState(this.path);
  }

  private levelState(path: readonly NestedPickerRow<TValue>[]): LevelState {
    const key = levelKey(path);
    let state = this.levelStates.get(key);
    if (!state) {
      state = { selectedIndex: 0, scrollOffset: 0, query: "" };
      this.levelStates.set(key, state);
    }
    return state;
  }

  private syncInputToLevel(): void {
    if (!this.input) return;
    const value = this.currentLevelState().query;
    if (this.input.getValue() !== value) this.input.setValue(value);
  }

  private fullActivePath(): readonly NestedPickerRow<TValue>[] {
    return this.activeLeaf ? [...this.path, this.activeLeaf] : this.path;
  }

  private visibleRows(): number {
    return Math.max(1, this.options.visibleRows ?? 10);
  }

  private clampSelection(state: LevelState, rowCount: number): void {
    if (rowCount <= 0) {
      state.selectedIndex = 0;
      state.scrollOffset = 0;
      return;
    }
    state.selectedIndex = Math.max(0, Math.min(state.selectedIndex, rowCount - 1));
    state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, rowCount - 1));
  }

  private keepSelectionVisible(state: LevelState, rowCount: number): void {
    if (rowCount <= 0) return;
    const visibleRows = this.visibleRows();
    if (state.selectedIndex < state.scrollOffset) state.scrollOffset = state.selectedIndex;
    if (state.selectedIndex >= state.scrollOffset + visibleRows) {
      state.scrollOffset = state.selectedIndex - visibleRows + 1;
    }
  }

  private applyFocus(): void {
    if (this.input) this.input.focused = this.focusedValue && this.activeLeaf === undefined;
    if (isComponent(this.activeContent) && isFocusable(this.activeContent)) {
      this.activeContent.focused = this.focusedValue && this.activeLeaf !== undefined;
    }
  }
}

function defaultFilterRows<TValue>(
  rows: readonly NestedPickerRow<TValue>[],
  query: string,
): readonly NestedPickerRow<TValue>[] {
  const normalized = query.toLocaleLowerCase();
  return rows.filter((row) => {
    const haystack = `${row.label}\n${row.description ?? ""}`.toLocaleLowerCase();
    return haystack.includes(normalized);
  });
}

function hasChildren<TValue>(row: NestedPickerRow<TValue>): boolean {
  return (row.children?.length ?? 0) > 0;
}

function levelKey<TValue>(path: readonly NestedPickerRow<TValue>[]): string {
  return JSON.stringify(path.map((row) => row.id));
}

function isComponent(value: NestedPickerContent | undefined): value is Component {
  return typeof value === "object" && value !== null && "render" in value && "invalidate" in value;
}

class NestedPickerChrome {
  constructor(private readonly theme: NestedPickerPanelTheme) {}

  render(title: string, width: number, lines: string[]): string[] {
    if (width < 1) return [""];
    return [
      this.horizontalRule(width),
      this.frameLine(this.theme.fg("accent", title), width),
      ...lines.map((line) => this.frameLine(line, width)),
      this.horizontalRule(width),
    ];
  }

  private horizontalRule(width: number): string {
    return this.theme.fg("border", "─".repeat(Math.max(0, width)));
  }

  private frameLine(text: string, width: number): string {
    const clipped = truncateToWidth(text, width, "");
    const pad = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
    return `${clipped}${pad}`;
  }
}
