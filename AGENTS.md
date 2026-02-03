# AGENTS.md — Chat Gateway Hard Constraints

These rules are mandatory for any agent working in this repo.

## Core principles (non-negotiable)
1) Chat Gateway must remain generic and domain-agnostic.
2) Business logic is prohibited outside src/integrations.
3) Business logic inside src/integrations is allowed only for explicitly approved domains.
   - If no allowlist is provided, ask before implementing.

## Change-control rules
- Before making any code, config, or doc changes, request explicit user approval.
- Do not add business constants, alert types, priority tables, or domain-specific routing outside src/integrations.
- Do not introduce business-specific config keys or types in core.
- Do not implement migrations or refactors unless explicitly requested.

## Enforcement guidance
- If you find business logic outside src/integrations, report it and wait for instructions.
- Keep core, entrypoints, providers, and shared utilities domain-agnostic.
- When business logic is added or removed, update docs/business-logic-scan.md.

When in doubt, stop and ask.
