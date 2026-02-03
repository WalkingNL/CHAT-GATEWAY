# Chat Gateway Business Logic Scan (Snapshot)

Date: 2026-02-03
Repo: CHAT-GATEWAY
Scope: paths under src/ and config/, focus on business/domain coupling.

## Findings: business logic inside src/integrations (expected area)
- src/integrations/channels/
  - charts.ts: chart/visual response for alerts
  - feedback.ts: feedback parsing/handling for alerts
  - telegramPolling.ts, feishuWebhook.ts: channel handlers (business payloads)
- src/integrations/explain/
  - path registry + per-path explainers under paths/
  - examples: stablecoin_liquidity.ts, volume_price_divergence.ts, system_health_suspect.ts
- src/integrations/facts/
  - alert_parse.ts and provider_local_fs.ts: alert facts parsing + local facts provider
- src/integrations/router/
  - commands.ts, router.ts, context.ts: command + intent routing (business intents)
- src/integrations/runtime/
  - intent_router.ts, intent_schema.ts, strategy.ts, response_templates.ts
  - notify_server.ts, query.ts, dispatch.ts, handlers.ts
  - on_demand_mapping.ts, project_registry.ts
- src/integrations/auth/, src/integrations/audit/
  - auth store and audit ledger/trace writers used by integrations

## Findings: business-logic coupling outside src/integrations (policy violation risk)
- src/core/config/index.ts
  - hard-coded capabilities include "alerts.explain" and "ops.help"
  - explain-specific require flags: mention_bot_for_explain, reply_required_for_explain
- src/core/config/eval.ts, src/core/config/types.ts
  - type/system rules reference "alerts.explain" and explain-specific requirements
- src/core/notify_overrides.ts
  - notify target overrides with min_priority and channel-specific targets
- src/core/project_registry_types.ts
  - per-project notify/on_demand fields (telegram/feishu chat ids, overrides)
- src/core/cognitive_store.ts
  - CognitiveType includes "alert_followup"

## Notes
- This scan is descriptive only; it is not a migration plan.
- Treat items above as candidates for relocation per the "no business logic outside integrations" rule.
