import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/** Schema for one selectable answer option in an interview question. */
export const optionSchema = Type.Object({
  value: Type.String({ description: "Stable value returned when this option is selected" }),
  label: Type.String({ description: "Short option label shown to the user" }),
  description: Type.Optional(
    Type.String({ description: "One-line helper text shown under the label" }),
  ),
  preview: Type.Optional(
    Type.String({
      description:
        "Optional code, ASCII diagram, or plain text preview shown when this option is highlighted",
    }),
  ),
});

/** Schema for one single-choice or multi-choice interview question. */
export const questionSchema = Type.Object({
  id: Type.String({ description: "Stable question id" }),
  title: Type.String({ description: "Question text shown to the user" }),
  type: StringEnum(["single", "multi"] as const),
  options: Type.Array(optionSchema, { minItems: 1 }),
  allowCustom: Type.Optional(
    Type.Boolean({ description: "Allow the user to type a custom answer" }),
  ),
});

/** Tool input schema for the structured interview UI. */
export const interviewSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "Short interview title" })),
  questions: Type.Array(questionSchema, { minItems: 1 }),
});

/** Tool input accepted by the interview_user tool. */
export type InterviewInput = Static<typeof interviewSchema>;

/** One question from an interview input. */
export type Question = InterviewInput["questions"][number];

/** One selectable option from an interview question. */
export type Option = Question["options"][number];

/** One answer returned after the user submits an interview. */
export interface Answer {
  /** Stable question id being answered. */
  questionId: string;
  /** Question selection mode. */
  type: "single" | "multi";
  /** Stable option values selected by the user. */
  selected: string[];
  /** Optional custom text entered by the user. */
  custom?: string;
  /** Optional notes keyed by selected option value. */
  notes?: Record<string, string>;
}

/** Result returned by the interactive interview panel. */
export type InterviewResult =
  | { status: "submitted"; answers: Answer[] }
  | { status: "cancelled" }
  | {
      status: "chat";
      questionId: string;
      question: string;
      selected: string[];
      custom?: string;
      notes?: Record<string, string>;
    };
