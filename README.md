# CHAT-GATEWAY

Core gateway + integrations split. Core stays reusable; channel-specific logic lives in integrations.

## Structure

- Core: internal API, providers, config/policy, rate limits, storage
- Integrations: Telegram/Feishu + business handlers (charts, feedback, explain, ops)

## Entrypoints

Default entrypoint (`src/index.ts`) imports core-only to avoid accidentally running integrations/all-in-one.

Core only (default):

```bash
export CHAT_GATEWAY_TOKEN="your-token"
export DEEPSEEK_API_KEY="your-deepseek-key"
npx tsx src/entrypoints/core.ts
```

Integrations-all (recommended for v1):

```bash
export CHAT_GATEWAY_TOKEN="your-token"
export CHAT_GATEWAY_INTERNAL_URL="http://127.0.0.1:8787"
export TELEGRAM_BOT_TOKEN="your-telegram-token"
export FEISHU_APP_ID="..."
export FEISHU_APP_SECRET="..."
export FEISHU_VERIFICATION_TOKEN="..."
export FEISHU_BOT_USER_ID="..."
export FEISHU_BOT_OPEN_ID="..."
npx tsx src/entrypoints/integrations_all.ts
```

Telegram integration (optional split, core runs separately):

```bash
export CHAT_GATEWAY_TOKEN="your-token"
export CHAT_GATEWAY_INTERNAL_URL="http://127.0.0.1:8787"
export TELEGRAM_BOT_TOKEN="your-telegram-token"
npx tsx src/entrypoints/telegram.ts
```

Feishu integration (optional split, core runs separately):

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

All-in-one (dev/emergency only):

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
- Run integrations-all (`src/entrypoints/integrations_all.ts`) for TG + Feishu + notify.
- Split Telegram/Feishu only if you need separate processes.
- `all_in_one` is for dev/emergency only; do not rely on it in production.

## Hard guardrail

- Each channel (telegram/feishu) must have only one instance running at a time.
- For high availability, use a leader lock (e.g., pidfile/flock) instead of multiple active instances.

## Port conflicts

- Core listens on `CHAT_GATEWAY_HOST` + `CHAT_GATEWAY_PORT` (default `127.0.0.1:8787`).
- Feishu entrypoint runs its own webhook server. Default port = `CHAT_GATEWAY_PORT + 1` unless `FEISHU_WEBHOOK_PORT` is set.
- Integrations notify server uses `INTEGRATIONS_PORT` (default `CHAT_GATEWAY_PORT + 2`).
- All-in-one runs core + Feishu + notify in a single process; do not run it alongside core.

## Optional env overrides

- `CHAT_GATEWAY_HOST`, `CHAT_GATEWAY_PORT`: core listen address
- `CHAT_GATEWAY_INTERNAL_URL`: integrations -> core base URL
- `FEISHU_WEBHOOK_HOST`, `FEISHU_WEBHOOK_PORT`: Feishu webhook server (defaults to gateway host + port+1)
- `INTEGRATIONS_HOST`, `INTEGRATIONS_PORT`: integrations notify server (defaults to gateway host + port+2)
- `PROJECTS_REGISTRY_PATH`: notify registry file (default `config/projects.yml`)
- `CHAT_GATEWAY_EXEC_MAX_GLOBAL`: global execFile concurrency (default 8)
- `CHAT_GATEWAY_EXEC_MAX_TELEGRAM`, `CHAT_GATEWAY_EXEC_MAX_FEISHU`, `CHAT_GATEWAY_EXEC_MAX_NOTIFY`, `CHAT_GATEWAY_EXEC_MAX_CHARTS`: per-module execFile concurrency
- `CHAT_GATEWAY_EXEC_WARN_QUEUE`, `CHAT_GATEWAY_EXEC_WARN_WAIT_MS`, `CHAT_GATEWAY_EXEC_LOG_INTERVAL_MS`: exec queue observability thresholds
- `CHAT_GATEWAY_EXEC_TIMEOUT_MS`: exec per-call timeout in ms (default 60000)
- `CHAT_GATEWAY_EXEC_TIMEOUT_TELEGRAM_MS`, `CHAT_GATEWAY_EXEC_TIMEOUT_FEISHU_MS`, `CHAT_GATEWAY_EXEC_TIMEOUT_NOTIFY_MS`, `CHAT_GATEWAY_EXEC_TIMEOUT_CHARTS_MS`: per-module timeout overrides
- `CHAT_GATEWAY_CIRCUIT_OPEN_AFTER`, `CHAT_GATEWAY_CIRCUIT_OPEN_MS`: supervisor circuit breaker (defaults 5 failures / 60s)
- `CHAT_GATEWAY_CIRCUIT_OPEN_AFTER_TELEGRAM`, `CHAT_GATEWAY_CIRCUIT_OPEN_AFTER_FEISHU`, `CHAT_GATEWAY_CIRCUIT_OPEN_AFTER_NOTIFY`: per-module overrides
- `CHAT_GATEWAY_CIRCUIT_OPEN_MS_TELEGRAM`, `CHAT_GATEWAY_CIRCUIT_OPEN_MS_FEISHU`, `CHAT_GATEWAY_CIRCUIT_OPEN_MS_NOTIFY`: per-module overrides
- `CHAT_GATEWAY_MAX_RESTARTS_PER_HOUR` (default 30) and `CHAT_GATEWAY_MAX_RESTARTS_TELEGRAM_PER_HOUR`/`FEISHU`/`NOTIFY`
- `CHAT_GATEWAY_SUPERVISE_RESET_MS` and `CHAT_GATEWAY_SUPERVISE_RESET_MS_TELEGRAM`/`FEISHU`/`NOTIFY`

Supervisor backoff defaults: 1s → 2s → 5s → 10s → 30s (max 30s). Not currently configurable.

## Core HTTP API

- `GET /health` -> `{ ok: true }` (auth required)
- `POST /v1/tasks`

## Integrations notify API

Auth: `Authorization: Bearer $CHAT_GATEWAY_TOKEN` (required)
Network: internal-only (loopback/private IPs). Only trust direct socket address; X-Forwarded-For is ignored. Bind `INTEGRATIONS_HOST=127.0.0.1` or a private IP.
Registry: `config/projects.yml` auto-reloads on mtime change; `SIGHUP` forces reload.

- `POST /v1/notify/text`
  - `target`: telegram | feishu | both (default both)
  - `project_id`: lookup defaults in `config/projects.yml`
  - `chat_id` / `chat_ids` / `chat_ids_by_target`: explicit override
  - `text`: required
- `POST /v1/notify/image`
  - `image_path` (preferred) or `image_url` (optional)
  - `caption`: optional
  - `project_id` / `chat_id(s)`: same as text
  - extra fields are ignored (reserved for future extensions)

Response (text/image):
- `ok: true`
- `target_overrides`: per-target override map (chat_id -> min_priority|null), if configured

Registry extensions (`config/projects.yml`):
- `on_demand.window_spec_id`: optional default `window_spec_id` for dashboard exports
- `notify_overrides`: per-target overrides (list or map), used to surface `target_overrides`

## Failure matrix

| Scenario | Behavior |
| --- | --- |
| Downstream TG/Feishu/notify crash | supervisor backoff + circuit breaker; restart limit can stop the loop |
| Exec queue saturation | concurrency caps prevent fork storm; WARN logs show queue/wait stats |
| Exec timeout | per-call timeout kills the subprocess; caller sees error |
| Registry reload failure | keep last good config; WARN with hash; next mtime/SIGHUP retries |
| Network jitter/timeouts | curl timeouts raise errors; supervisor backoff isolates failures |

## Verification

- Type check: `npm run build` (tsc); for tsx-only flows, run `tsx --typecheck` if needed.
- Lint (if configured in this repo).

## Networking note

Telegram channel uses system `curl -4` for stability on this host.
Node fetch/undici is intentionally not used.
