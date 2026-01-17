# CHAT-GATEWAY

Core gateway + integrations split. Core stays reusable; channel-specific logic lives in integrations.

## Structure

- Core: internal API, providers, config/policy, rate limits, storage
- Integrations: Telegram/Feishu + business handlers (charts, feedback, explain, ops)

## Entrypoints

Core only (default):

```bash
export CHAT_GATEWAY_TOKEN="your-token"
export DEEPSEEK_API_KEY="your-deepseek-key"
npx tsx src/entrypoints/core.ts
```

Telegram integration (core runs separately):

```bash
export CHAT_GATEWAY_TOKEN="your-token"
export CHAT_GATEWAY_INTERNAL_URL="http://127.0.0.1:8787"
export TELEGRAM_BOT_TOKEN="your-telegram-token"
npx tsx src/entrypoints/telegram.ts
```

Feishu integration (core runs separately):

```bash
export CHAT_GATEWAY_TOKEN="your-token"
export CHAT_GATEWAY_INTERNAL_URL="http://127.0.0.1:8787"
export FEISHU_APP_ID="..."
export FEISHU_APP_SECRET="..."
export FEISHU_VERIFICATION_TOKEN="..."
export FEISHU_BOT_USER_ID="..."
export FEISHU_BOT_OPEN_ID="..."
npx tsx src/entrypoints/feishu.ts
```

All-in-one (local dev):

```bash
export CHAT_GATEWAY_TOKEN="your-token"
export DEEPSEEK_API_KEY="your-deepseek-key"
export TELEGRAM_BOT_TOKEN="your-telegram-token"
export FEISHU_APP_ID="..."
export FEISHU_APP_SECRET="..."
export FEISHU_VERIFICATION_TOKEN="..."
export FEISHU_BOT_USER_ID="..."
export FEISHU_BOT_OPEN_ID="..."
npx tsx src/entrypoints/all_in_one.ts
```

## Production recommendation

- Run core only (`src/entrypoints/core.ts`) as the single writer for tasks.
- Run integrations as separate processes:
  - Telegram: `src/entrypoints/telegram.ts` (no server, just polling)
  - Feishu: `src/entrypoints/feishu.ts` (separate webhook server)

## Hard guardrail

- Each channel (telegram/feishu) must have only one instance running at a time.
- For high availability, use a leader lock (e.g., pidfile/flock) instead of multiple active instances.

## Port conflicts

- Core listens on `CHAT_GATEWAY_HOST` + `CHAT_GATEWAY_PORT` (default `127.0.0.1:8787`).
- Feishu entrypoint runs its own webhook server. Default port = `CHAT_GATEWAY_PORT + 1` unless `FEISHU_WEBHOOK_PORT` is set.
- All-in-one binds internal API and Feishu webhook on the same port; do not run it alongside core.

## Optional env overrides

- `CHAT_GATEWAY_HOST`, `CHAT_GATEWAY_PORT`: core listen address
- `CHAT_GATEWAY_INTERNAL_URL`: integrations -> core base URL
- `FEISHU_WEBHOOK_HOST`, `FEISHU_WEBHOOK_PORT`: Feishu webhook server (defaults to gateway host + port+1)

## HTTP API

- `GET /health` -> `{ ok: true }` (auth required)
- `POST /v1/tasks`

## Networking note

Telegram channel uses system `curl -4` for stability on this host.
Node fetch/undici is intentionally not used.
