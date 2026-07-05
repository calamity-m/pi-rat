# pi-rat

lil rat

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
