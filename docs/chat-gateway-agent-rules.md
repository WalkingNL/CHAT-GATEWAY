# Chat Gateway Hard Rules for Agents

Date: 2026-02-03
Purpose: mandatory constraints for changes to CHAT-GATEWAY.

## Non-negotiable principles
1) Chat Gateway must remain generic. No business/domain binding in core.
2) Outside src/integrations, business logic is prohibited.
3) Inside src/integrations, business logic is allowed only for explicitly approved business domains.
   - If no allowlist is provided, assume none and ask before implementing.

## Change-control rules
- Before making any code or doc changes, request explicit user approval.
- Do not add new business constants, alert types, priority tables, or domain-specific routing outside src/integrations.
- Do not introduce business-specific config keys in core types/schemas without approval.
- If a change touches business logic, confirm its allowed domain and location (integrations subdir) before editing.
- Do not implement migrations unless explicitly requested.

## What counts as business logic (examples)
- Alert types, priority levels, explain paths, feedback parsing, notify overrides, domain-specific policies, or project-specific routing.
- Any capability named after a product/domain (e.g., "alerts.explain").

## Allowed locations
- Business logic (when approved) must live under src/integrations/<domain>/ or src/integrations/<feature>/.
- Core, entrypoints, providers, config loaders, and shared utilities must remain domain-agnostic.

## Required documentation
- Update docs/business-logic-scan.md after adding or removing business logic.
- Document any new allowed business domain in this file before implementation.
