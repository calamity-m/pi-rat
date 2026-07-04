import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Focusable, type TUI } from "@earendil-works/pi-tui";

import { padToWidth, sideBySide, wrapCustomAnswer } from "./layout.ts";
import type { InterviewInput, InterviewResult, Option, Question } from "./types.ts";

/** Interactive TUI component that collects structured interview answers from the user. */
export class InterviewPanel implements Focusable {
  focused = false;
  private questionIndex = 0;
  private selectedRow = 0;
  private typingCustom = false;
  private typingNotes = false;
  private noteTarget: Option | undefined;
  private reviewMode = false;
  private readonly selected = new Map<string, Set<string>>();
  private readonly custom = new Map<string, string>();
  private readonly notes = new Map<string, Map<string, string>>();
  private readonly input: InterviewInput;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: (result: InterviewResult) => void;

  /** Build an interview panel from validated tool input. */
  constructor(
    input: InterviewInput,
    tui: TUI,
    theme: Theme,
    done: (result: InterviewResult) => void,
  ) {
    this.input = input;
    this.tui = tui;
    this.theme = theme;
    this.done = done;
  }

  /** Handle keyboard input for navigation, selection, submission, and cancellation. */
  handleInput(data: string): void {
    if (this.typingCustom) {
      this.handleCustomInput(data);
      return;
    }
    if (this.typingNotes) {
      this.handleNotesInput(data);
      return;
    }

    if (matchesKey(data, "escape")) return this.done({ status: "cancelled" });
    if (matchesKey(data, "up")) this.move(-1);
    else if (matchesKey(data, "down")) this.move(1);
    else if (matchesKey(data, "tab") || matchesKey(data, "right")) this.next();
    else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) this.prev();
    else if (data === "n" && !this.reviewMode) this.editNotes();
    else if (matchesKey(data, "return") || data === " ") this.activate();
    else return;

    this.tui.requestRender();
  }

  /** Render the active question or final review screen. */
  render(width: number): string[] {
    const q = this.question;
    const rows = this.rowCount(q);
    this.selectedRow = Math.min(this.selectedRow, rows - 1);
    const selected = this.selectedFor(q);
    const lines: string[] = [];

    lines.push(this.theme.fg("border", "─".repeat(Math.max(0, width))));
    lines.push(
      this.theme.fg("accent", truncateToWidth(this.input.title ?? "Interview", width, "")),
    );
    lines.push(this.progress(width));
    lines.push("");
    if (this.reviewMode) {
      lines.push(this.theme.fg("accent", truncateToWidth("Review answers", width, "")));
      lines.push("");
      lines.push(...this.answerOverview(width));
      lines.push(this.theme.fg("border", "─".repeat(Math.max(0, width))));
      lines.push(this.formatActionLine(" Submit", width, true));
    } else {
      lines.push(this.theme.fg("accent", truncateToWidth(q.title, width, "")));
      lines.push("");
      lines.push(...this.renderQuestionBody(q, selected, width, rows));
    }
    lines.push("");
    lines.push(this.theme.fg("dim", "Enter select · n notes · Tab/←/→ navigate · Esc cancel"));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  /** No-op required by the Pi custom component lifecycle. */
  invalidate(): void {}

  /** Current question shown by the panel. */
  private get question(): Question {
    return this.input.questions[this.questionIndex];
  }

  /** Color and pad one option or description row. */
  private formatOptionLine(
    text: string,
    width: number,
    active: boolean,
    checked: boolean,
    description = false,
  ): string {
    const line = padToWidth(truncateToWidth(text, width, ""), width);
    if (active)
      return this.theme.bg("selectedBg", this.theme.fg(checked ? "success" : "accent", line));
    if (checked) return this.theme.fg(description ? "muted" : "success", line);
    if (description) return this.theme.fg("dim", line);
    return line;
  }

  /** Color and pad one action row. */
  private formatActionLine(text: string, width: number, active: boolean): string {
    const line = padToWidth(truncateToWidth(text, width, ""), width);
    return active ? this.theme.bg("selectedBg", this.theme.fg("accent", line)) : line;
  }

  /** Render the active question with options, optional preview, and action rows. */
  private renderQuestionBody(
    question: Question,
    selected: Set<string>,
    width: number,
    rows: number,
  ): string[] {
    const optionLines = this.renderOptionLines(question, selected, width);
    const preview = this.selectedPreview(question);
    const bodyLines =
      preview && width >= 100
        ? sideBySide(optionLines, this.renderPreview(preview, Math.floor(width * 0.45)), width)
        : optionLines;
    return [
      ...bodyLines,
      ...(preview && width < 100 ? ["", ...this.renderPreview(preview, width)] : []),
      this.theme.fg("border", "─".repeat(Math.max(0, width))),
      this.formatActionLine(this.chatRow(question), width, this.selectedRow === rows - 2),
      this.formatActionLine(this.submitRow(question), width, this.selectedRow === rows - 1),
    ];
  }

  /** Render all selectable answers for one question. */
  private renderOptionLines(question: Question, selected: Set<string>, width: number): string[] {
    const lines: string[] = [];
    question.options.forEach((option, i) => {
      const active = this.selectedRow === i;
      const checked = selected.has(option.value);
      const marker = active ? "❯" : " ";
      const checkbox = question.type === "multi" ? `[${checked ? "x" : " "}]` : checked ? "●" : "○";
      const label = `${marker} ${i + 1}. ${checkbox} ${option.label}`;
      lines.push(this.formatOptionLine(label, width, active, checked));
      if (option.description)
        lines.push(this.formatOptionLine(`   ${option.description}`, width, active, checked, true));
      lines.push(...this.renderOptionNotes(question, option, active, width));
    });

    if (question.allowCustom) {
      const row = question.options.length;
      const active = this.selectedRow === row;
      const value = this.custom.get(question.id) ?? "";
      const cursor = this.typingCustom ? "█" : "";
      const prompt = this.typingCustom ? "Editing custom answer" : "Type something";
      const prefix = `${active ? "❯" : " "} ${row + 1}. ${prompt}`;
      const wrapped = wrapCustomAnswer(
        prefix,
        value || this.typingCustom ? `${value}${cursor}` : "",
        width,
      );
      lines.push(
        ...wrapped.map((line) => this.formatOptionLine(line, width, active, Boolean(value.trim()))),
      );
      if (active)
        lines.push(
          this.theme.fg(
            "dim",
            this.typingCustom
              ? "   Type text · Enter save · Esc stop editing"
              : "   Enter to edit custom answer",
          ),
        );
    }
    return lines;
  }

  /** Return the preview text for the highlighted option, if present. */
  private selectedPreview(question: Question): string | undefined {
    if (this.selectedRow < 0 || this.selectedRow >= question.options.length) return undefined;
    return question.options[this.selectedRow].preview?.trim() || undefined;
  }

  /** Render a preview box for a highlighted option. */
  private renderPreview(preview: string, width: number): string[] {
    const innerWidth = Math.max(10, width - 4);
    const border = (text: string) => this.theme.fg("border", text);
    const rawLines = preview
      .replace(/\\n/g, "\n")
      .replace(/^\n+|\n+$/g, "")
      .split("\n")
      .slice(0, 14);
    const lines = rawLines.map((line) =>
      padToWidth(truncateToWidth(line, innerWidth, ""), innerWidth),
    );
    return [
      border(`╭${"─".repeat(innerWidth + 2)}╮`),
      `${border("│ ")}${this.theme.fg("muted", padToWidth("Preview", innerWidth))}${border(" │")}`,
      border(`├${"─".repeat(innerWidth + 2)}┤`),
      ...lines.map((line) => `${border("│ ")}${line}${border(" │")}`),
      border(`╰${"─".repeat(innerWidth + 2)}╯`),
    ];
  }

  /** Return the mutable set of selected option values for a question. */
  private selectedFor(question: Question): Set<string> {
    let values = this.selected.get(question.id);
    if (!values) {
      values = new Set();
      this.selected.set(question.id, values);
    }
    return values;
  }

  /** Count navigable rows for one question, including actions. */
  private rowCount(question: Question): number {
    return question.options.length + (question.allowCustom ? 1 : 0) + 2;
  }

  /** Move the highlighted row by a clamped delta. */
  private move(delta: number): void {
    const rows = this.rowCount(this.question);
    this.selectedRow = Math.max(0, Math.min(rows - 1, this.selectedRow + delta));
  }

  /** Move to the next question or into review mode. */
  private next(): void {
    if (this.reviewMode) {
      this.reviewMode = false;
      this.questionIndex = 0;
      this.selectedRow = 0;
      return;
    }
    if (this.questionIndex < this.input.questions.length - 1) {
      this.questionIndex++;
      this.selectedRow = 0;
    } else {
      this.reviewMode = true;
      this.selectedRow = 0;
    }
  }

  /** Move to the previous question or leave review mode. */
  private prev(): void {
    if (this.reviewMode) {
      this.reviewMode = false;
      this.questionIndex = this.input.questions.length - 1;
      this.selectedRow = 0;
      return;
    }
    if (this.questionIndex > 0) {
      this.questionIndex--;
      this.selectedRow = 0;
    }
  }

  /** Activate the highlighted option or action row. */
  private activate(): void {
    if (this.reviewMode) return this.submit();
    const q = this.question;
    if (this.selectedRow < q.options.length)
      return this.toggleOption(q, q.options[this.selectedRow]);
    if (q.allowCustom && this.selectedRow === q.options.length) {
      this.typingCustom = true;
      return;
    }
    if (this.selectedRow === this.rowCount(q) - 2) {
      return this.done({
        status: "chat",
        questionId: q.id,
        question: q.title,
        selected: [...this.selectedFor(q)],
        custom: this.custom.get(q.id),
        notes: this.selectedNotes(q),
      });
    }
    this.reviewMode = true;
  }

  /** Submit all collected answers. */
  private submit(): void {
    this.done({
      status: "submitted",
      answers: this.input.questions.map((question) => ({
        questionId: question.id,
        type: question.type,
        selected: [...this.selectedFor(question)],
        custom: this.custom.get(question.id),
        notes: this.selectedNotes(question),
      })),
    });
  }

  /** Toggle one selected option according to the question's selection mode. */
  private toggleOption(question: Question, option: Option): void {
    const values = this.selectedFor(question);
    if (question.type === "single") {
      values.clear();
      values.add(option.value);
      this.custom.delete(question.id);
      this.next();
      return;
    }
    if (values.has(option.value)) values.delete(option.value);
    else values.add(option.value);
  }

  /** Start editing notes for the highlighted option entry. */
  private editNotes(): void {
    if (this.selectedRow >= this.question.options.length) return;
    this.noteTarget = this.question.options[this.selectedRow];
    this.typingNotes = true;
  }

  /** Handle text editing keys while the custom answer editor is active. */
  private handleCustomInput(data: string): void {
    const q = this.question;
    if (matchesKey(data, "escape")) this.typingCustom = false;
    else if (matchesKey(data, "return")) {
      this.typingCustom = false;
      if (q.type === "single") this.selectedFor(q).clear();
      this.next();
    } else if (matchesKey(data, "backspace")) {
      const value = this.custom.get(q.id) ?? "";
      this.custom.set(q.id, value.slice(0, -1));
    } else if (data.length === 1 && data >= " ") {
      this.custom.set(q.id, `${this.custom.get(q.id) ?? ""}${data}`);
    } else return;
    this.tui.requestRender();
  }

  /** Handle text editing keys while the notes editor is active. */
  private handleNotesInput(data: string): void {
    const q = this.question;
    const target = this.noteTarget;
    if (!target) {
      this.typingNotes = false;
      return;
    }

    if (matchesKey(data, "escape")) this.typingNotes = false;
    else if (matchesKey(data, "return")) {
      this.typingNotes = false;
    } else if (matchesKey(data, "backspace")) {
      const value = this.noteFor(q, target.value);
      this.setNote(q, target.value, value.slice(0, -1));
    } else if (data.length === 1 && data >= " ") {
      this.setNote(q, target.value, `${this.noteFor(q, target.value)}${data}`);
    } else return;
    this.tui.requestRender();
  }

  /** Render question progress and answer status. */
  private progress(width: number): string {
    const onSubmit = this.reviewMode;
    const parts = [
      this.theme.fg("dim", "←"),
      ...this.input.questions.map((q, i) => {
        const active = i === this.questionIndex && !onSubmit;
        const text = `${this.hasAnswer(q) ? "☑" : "☐"} ${q.id}`;
        if (active) return this.theme.fg("accent", this.theme.bold(text));
        if (this.hasAnswer(q)) return this.theme.fg("success", text);
        return this.theme.fg("dim", text);
      }),
      onSubmit
        ? this.theme.fg("accent", this.theme.bold("✔ Submit"))
        : this.theme.fg("dim", "✔ Submit"),
      this.theme.fg("dim", "→"),
    ];
    return truncateToWidth(parts.join("  "), width, "");
  }

  /** Whether a question currently has at least one option or custom answer. */
  private hasAnswer(question: Question): boolean {
    return this.selectedFor(question).size > 0 || Boolean(this.custom.get(question.id)?.trim());
  }

  /** Render the review-mode answer summary. */
  private answerOverview(width: number): string[] {
    return this.input.questions.flatMap((question) => {
      const labels = question.options
        .filter((option) => this.selectedFor(question).has(option.value))
        .map((option) => {
          const notes = this.noteFor(question, option.value).trim();
          return notes ? `${option.label} (notes: ${notes})` : option.label;
        });
      const custom = this.custom.get(question.id)?.trim();
      const answer = [...labels, ...(custom ? [custom] : [])].join(", ");
      const line = answer
        ? ` ${this.theme.fg("accent", question.id)}${this.theme.fg("dim", ":")} ${this.theme.fg("success", answer)}`
        : ` ${this.theme.fg("accent", question.id)}${this.theme.fg("dim", ":")} ${this.theme.fg("muted", "—")}`;
      return [truncateToWidth(line, width, "")];
    });
  }

  /** Render notes attached to one option entry. */
  private renderOptionNotes(
    question: Question,
    option: Option,
    active: boolean,
    width: number,
  ): string[] {
    const editing = this.typingNotes && this.noteTarget?.value === option.value;
    const value = this.noteFor(question, option.value);
    const cursor = editing ? "█" : "";
    const lines = wrapCustomAnswer("   notes", `${value}${cursor}`, width)
      .filter(() => value || editing)
      .map((line) => this.formatOptionLine(line, width, active, false, true));
    if (active)
      lines.push(
        this.theme.fg(
          "dim",
          editing ? "   Type notes · Enter save · Esc stop editing" : "   n to edit notes",
        ),
      );
    return lines;
  }

  /** Return notes for selected options, keyed by option value. */
  private selectedNotes(question: Question): Record<string, string> | undefined {
    const values = this.selectedFor(question);
    const entries = [...(this.notes.get(question.id)?.entries() ?? [])].filter(
      ([value, notes]) => values.has(value) && Boolean(notes.trim()),
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  /** Return one option's notes, if any. */
  private noteFor(question: Question, value: string): string {
    return this.notes.get(question.id)?.get(value) ?? "";
  }

  /** Set or remove one option's notes. */
  private setNote(question: Question, value: string, notes: string): void {
    let questionNotes = this.notes.get(question.id);
    if (!questionNotes) {
      questionNotes = new Map();
      this.notes.set(question.id, questionNotes);
    }
    if (notes) questionNotes.set(value, notes);
    else questionNotes.delete(value);
  }

  /** Label for the per-question chat action row. */
  private chatRow(question: Question): string {
    return ` ${this.rowNumber(question, 0)}. Chat about this`;
  }

  /** Label for the per-question submit/review action row. */
  private submitRow(question: Question): string {
    return ` ${this.rowNumber(question, 1)}. Submit`;
  }

  /** One-based row number for a question action. */
  private rowNumber(question: Question, offset: number): number {
    return question.options.length + (question.allowCustom ? 1 : 0) + 1 + offset;
  }
}
