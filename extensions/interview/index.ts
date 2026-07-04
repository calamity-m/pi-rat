import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import { InterviewPanel } from "./panel.ts";
import { interviewSchema, type InterviewInput, type InterviewResult } from "./types.ts";

/** Register the core structured-interview tool. */
export function registerInterview(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "interview_user",
    label: "Interview User",
    description:
      "Ask the user structured single-choice or multi-choice questions in an interactive UI and return their answers.",
    promptSnippet: "Ask the user structured questions with a temporary interview UI.",
    promptGuidelines: [
      "Use interview_user when you need the user's answers to several structured questions before choosing an implementation plan.",
      "Do not use interview_user for a single simple clarification that can be asked conversationally.",
    ],
    parameters: interviewSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "interview_user requires interactive UI mode." }],
          details: {},
          isError: true,
        };
      }

      const result = await ctx.ui.custom((tui, theme, _keybindings, done) => {
        return new InterviewPanel(params, tui, theme, done);
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
    renderCall(args, theme) {
      const title = args.title?.trim() || "Interview";
      const count = args.questions.length;
      return withInterviewCallRail(
        new Text(
          `${theme.fg("toolTitle", theme.bold("interview_user"))} ${theme.fg("accent", title)} ${theme.fg("muted", `(${count} question${count === 1 ? "" : "s"})`)}`,
          0,
          0,
        ),
        theme,
      );
    },
    renderResult(result, _options, theme, context) {
      return withInterviewOutputRail(
        new Text(
          formatInterviewResult(
            result.details as InterviewResult | undefined,
            context.args as InterviewInput,
            theme,
          ),
          0,
          0,
        ),
        theme,
      );
    },
  });
}

/** Left rail used for the interview tool call and result body. */
const INTERVIEW_OUTPUT_RAIL = "▌";

type ToolRenderComponent = ReturnType<NonNullable<ToolDefinition["renderResult"]>>;

class InterviewRail implements Component {
  constructor(
    readonly child: Component,
    private readonly rail: string,
    private readonly caps: boolean,
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const childWidth = Math.max(0, width - 2);
    const childLines = this.child.render(childWidth).map((line) => `${this.rail} ${line}`);
    return this.caps ? [this.rail, ...childLines, this.rail] : childLines;
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

function withInterviewCallRail(
  component: Component,
  theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1],
): Component {
  return new InterviewRail(component, theme.fg("accent", INTERVIEW_OUTPUT_RAIL), false);
}

function withInterviewOutputRail(
  component: ToolRenderComponent,
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
): ToolRenderComponent {
  return new InterviewRail(component, theme.fg("accent", INTERVIEW_OUTPUT_RAIL), true);
}

function formatInterviewResult(
  result: InterviewResult | undefined,
  input: InterviewInput,
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
): string {
  if (!result || typeof result !== "object" || !("status" in result)) {
    return theme.fg("warning", "↳ interview ended without a response");
  }

  if (result.status === "cancelled") return theme.fg("warning", "↳ interview cancelled");

  if (result.status === "chat") {
    return [
      theme.fg("accent", `↳ chat requested: ${result.questionId}`),
      formatAnswerLine(
        result.questionId,
        result.selected,
        result.custom,
        result.notes,
        input,
        theme,
      ),
    ].join("\n");
  }

  if (result.status !== "submitted" || !Array.isArray(result.answers)) {
    return theme.fg("warning", "↳ interview returned an unknown response");
  }

  const answered = result.answers.filter(
    (answer) => answer.selected.length > 0 || Boolean(answer.custom?.trim()),
  ).length;
  return [
    `${theme.fg("success", "✓ submitted")} ${theme.fg("muted", `${answered}/${result.answers.length} answered`)}`,
    ...result.answers.map((answer) =>
      formatAnswerLine(
        answer.questionId,
        answer.selected,
        answer.custom,
        answer.notes,
        input,
        theme,
      ),
    ),
  ].join("\n");
}

function formatAnswerLine(
  questionId: string,
  selected: readonly string[],
  custom: string | undefined,
  notes: Record<string, string> | undefined,
  input: InterviewInput,
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
): string {
  const question = input.questions.find((candidate) => candidate.id === questionId);
  const labels = selected.map((value) => {
    const label = question?.options.find((option) => option.value === value)?.label ?? value;
    const note = notes?.[value]?.trim();
    return note ? `${label} (${note})` : label;
  });
  const customAnswer = custom?.trim();
  const answer = [...labels, ...(customAnswer ? [`“${customAnswer}”`] : [])].join(", ");
  return `  ${theme.fg("accent", questionId)}${theme.fg("dim", ":")} ${answer ? theme.fg("muted", answer) : theme.fg("dim", "—")}`;
}

/** Default Pi extension entrypoint for standalone loading during development. */
export default function interviewExtension(pi: ExtensionAPI): void {
  registerInterview(pi);
}
