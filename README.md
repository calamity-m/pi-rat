# pi-rat

lil rat

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

## `/usage`

The bundled `usage` extension adds a `/usage` TUI picker:

1. Subscription usage
   - ChatGPT Codex
2. Tokens
3. Global Tokens

Selecting ChatGPT Codex shows ChatGPT subscription usage for the active `openai-codex` model, including plan, email, 5-hour usage, weekly usage, reset times, fetch time, and source endpoint.

Selecting Tokens lists local usage by provider/model across the current project's Pi session files; selecting a provider/model shows 30-day and all-time totals.

Selecting Global Tokens lists usage by provider/model across all Pi sessions under `~/.pi/agent/sessions/`; selecting a provider/model shows 30-day and all-time totals.

ChatGPT Codex usage uses Pi's existing ChatGPT OAuth credential from `/login`; a normal `OPENAI_API_KEY` is not enough. The data comes from `https://chatgpt.com/backend-api/wham/usage`.
