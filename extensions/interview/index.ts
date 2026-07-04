import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { InterviewPanel } from "./panel.ts";
import { interviewSchema } from "./types.ts";

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
  });
}

/** Default Pi extension entrypoint for standalone loading during development. */
export default function interviewExtension(pi: ExtensionAPI): void {
  registerInterview(pi);
}
