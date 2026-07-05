import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SESSION_RESET_COMMANDS = ["clear", "clean"] as const;

/** Register `/clear` and `/clean` as minimal aliases for Pi's `/new` session command. */
export default function registerSessionResets(pi: ExtensionAPI) {
  for (const command of SESSION_RESET_COMMANDS) {
    pi.registerCommand(command, {
      description: "Start a new session",
      handler: async (_args, ctx) => {
        await ctx.newSession();
      },
    });
  }
}
