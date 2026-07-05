# pi-rat

lil rat

## `/usage`

The bundled `usage` extension adds a `/usage` TUI picker:

1. Subscription usage
2. ChatGPT Codex

Selecting ChatGPT Codex shows ChatGPT subscription usage for the active `openai-codex` model, including plan, email, 5-hour usage, weekly usage, reset times, fetch time, and source endpoint.

This uses Pi's existing ChatGPT OAuth credential from `/login`; a normal `OPENAI_API_KEY` is not enough. The data comes from `https://chatgpt.com/backend-api/wham/usage`. V1 does not add footer/status display.
