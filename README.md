# pi-rat

lil rat

## `autoformatter`

The bundled `autoformatter` extension runs configured formatter commands after successful `write` or `edit` tool calls. Configure rules in `~/.pi/agent/settings.json` globally or `.pi/settings.json` per trusted project:

```json
{
  "autoformatter": {
    "formatters": [
      {
        "id": "oxfmt",
        "languages": ["typescript", "javascript"],
        "extensions": [".ts", ".tsx", ".js", ".jsx"],
        "command": "npx",
        "args": ["oxfmt", "{file}"],
        "cwd": "project",
        "timeoutMs": 10000
      }
    ]
  }
}
```

Project formatter rules override global rules by `languages`; language-less project rules override language-less global rules with the same `id`.

## `nested-agents-files`

The bundled `nested-agents-files` extension appends nested `AGENTS.md`/`CLAUDE.md` context when Pi successfully reads a file below the current working directory. It walks from the session cwd to the read file's directory, loads the first matching context file in each directory, and injects each context file at most once per session.

Example: reading `src/my/stuff/a.py` can inject `src/AGENTS.md` and `src/my/stuff/AGENTS.md`; a later read of `src/my/stuff/b.py` will not inject those same files again.

## `nested-prompts`

The bundled `nested-prompts` extension recursively registers Markdown prompt templates below the global `~/.pi/agent/prompts/` directory. Pi already discovers `~/.pi/agent/prompts/*.md`; this extension adds files matching `~/.pi/agent/prompts/**/*.md`. Run `/reload` after adding, moving, or removing prompt files.

Prompt command names remain the Markdown filename without `.md`, regardless of subdirectory. Avoid duplicate filenames because Pi resolves templates by command name.

## `/permissions`

The bundled `permissions` extension gates Pi tool calls from global user settings at `~/.pi/agent/settings.json`. It defaults to allowing tool calls unless the first matching rule says to prompt or deny.

```json
{
  "permissions": {
    "rules": [
      { "tool": "bash", "match": "rm\\s+-rf", "action": "prompt" },
      { "tool": "write", "match": "secrets", "action": "deny" },
      { "tool": "*", "match": ".*", "action": "prompt" }
    ]
  }
}
```

Rules are checked in order. `tool` is an exact tool name, or `*` for any tool. `match` is a JavaScript regular expression tested against stable JSON for the tool input. Actions are `prompt` and `deny`.

Prompted calls offer `Approve`, `Approve for session`, and `Deny`. Session approvals are in-memory only and apply to the exact same tool name and input until Pi reloads the extension. If a prompt is required but no interactive UI is available, the tool call is denied.

Run `/permissions` in TUI mode to browse:

1. Status
2. Rules
   - grouped by tool name
3. Approvals (Session)
   - grouped by tool name
4. init
   - adds starter prompt rules for `bash` commands containing `docker`, `curl`, `kubectl`, or `python -c`, plus `.env` reads/edits, then tells you to run `/reload`

## `/subagents`

The bundled `subagents` extension adds a `spawn_subagent` tool for isolated, ephemeral Pi agents. Use it for investigation, review, or second opinions; it returns only the subagent's final answer to the parent session.

`spawn_subagent` supports preset agents (`explorer`, `code-reviewer`, `oracle`), optional role/context/file preloading, and tool policies: `none`, `read-only` (default), or `coding`.

Run `/subagents` in TUI mode to browse active/recent runs, open transcript overlays, cancel active runs, and configure fast/high tier mappings. In non-TUI modes it reports current run state with a notification when UI is available.

Fast/high tiers are stored in `~/.pi/agent/settings.json` under `piRat.subagents`. Missing or unavailable tier mappings fall back to the parent session model; explicit raw `model` overrides remain strict.

```json
{
  "piRat": {
    "subagents": {
      "tiers": {
        "fast": { "model": "provider/model-id", "thinkingLevel": "minimal" },
        "high": { "model": "provider/model-id", "thinkingLevel": "high" }
      }
    }
  }
}
```

## `/usage`

The bundled `usage` extension adds a `/usage` TUI picker:

1. Subscription usage
   - ChatGPT Codex
2. System Prompt
   - Compiled System Prompt
   - Tools
   - Skills
   - Context Files
3. Tokens
4. Global Tokens

Selecting ChatGPT Codex shows ChatGPT subscription usage for the active `openai-codex` model, including plan, email, 5-hour usage, weekly usage, reset times, fetch time, and source endpoint.

Selecting System Prompt shows the compiled system prompt token estimate plus per-tool, per-skill, and per-context-file token estimates.

Selecting Tokens lists local usage by provider/model across the current project's Pi session files; selecting a provider/model shows 30-day and all-time totals.

Selecting Global Tokens lists usage by provider/model across all Pi sessions under `~/.pi/agent/sessions/`; selecting a provider/model shows 30-day and all-time totals.

ChatGPT Codex usage uses Pi's existing ChatGPT OAuth credential from `/login`; a normal `OPENAI_API_KEY` is not enough. The data comes from `https://chatgpt.com/backend-api/wham/usage`.

## Instance labels

The bundled footer extension uses Pi's session name (`pi --name ...` or `/name`) as an instance label. The label appears beside the prompt state (`● ready · label`) and in the terminal/window title.

Use `/label <name>` to set the label from inside Pi, `/label` to show the current label, and `/label --clear` to clear it.

Use `/colour` to pick a temporary editor border/label colour for the running instance. `/colour <name>` accepts `blue`, `cyan`, `green`, `yellow`, `orange`, `red`, `pink`, or `purple`; `/colour #rrggbb` accepts a custom RGB colour; `/colour --clear` restores the normal thinking-level border colour. The colour is in-memory only and does not survive `/reload` or restart.
