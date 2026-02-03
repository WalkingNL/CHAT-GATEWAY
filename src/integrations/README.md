# Integrations Index

This directory contains integration-layer logic for chat-gateway. The items below summarize what each area does, so reviewers do not need to scan the full tree.

## Areas and Responsibilities

### audit/
- **ledger.ts**: Append-only audit log entries for integration actions.
- **trace_writer.ts**: Trace logging for explain/feedback flows.

### auth/
- **store.ts**: Allowlist/owner authorization store and helpers.

### channels/
- **charts.ts**: Parse chart intents and call on-demand rendering endpoints.
- **feedback.ts**: Parse feedback phrases and update push policy state.
- **telegramPolling.ts**: Telegram polling integration.
- **feishuWebhook.ts**: Feishu webhook integration.

### explain/
- **router_v1.ts**: Explain routing and response assembly.
- **paths/**: Explain heuristics for known scenarios (noise patterns, divergence, etc.).
- **path_registry.ts / path_types.ts**: Explain path registry and types.

### facts/
- **alert_parse.ts**: Parse alert text into structured facts.
- **provider_local_fs.ts**: Local FS facts provider.
- **index.ts**: Facts export surface.

### router/
- **router.ts**: Primary message routing, intent resolve, and dispatch to handlers.
- **context.ts**: Status facts (e.g., feedback state).
- **commands.ts**: Built-in command parsing.

### runtime/
- **handlers.ts**: Intent-specific handlers (feedback, explain, charts, etc.).
- **strategy.ts**: /strategy read/update/rollback for push policy state.
- **query.ts**: /event /gate /eval /config /health lookups.
- **notify_server.ts**: Delivery routing + min_priority gate for notify calls.
- **intent_router.ts**: On-demand intent resolution client.
- **intent_schema.ts**: Intent schema helpers.
- **capabilities.ts**: Capability config loader and toggles.
- **cognitive.ts**: Cognitive record create/update flows.
- **dispatch.ts / telegram.ts / feishu.ts**: Runtime adapters.
- **response_templates.ts**: Standard response strings.
- **project_registry.ts / context.ts / audit_policy.ts / message_event.ts**: Runtime config & audit helpers.

## Notes
- Business logic should remain confined to `integrations/` per repo policy.
- When adding new capabilities, update this index to keep the mapping current.
