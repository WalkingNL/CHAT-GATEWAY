# Gateway Config Schema v1

This document defines the v1 schema for Project Manifest and Policy. The goal is to make new project onboarding copy-and-edit only.

## Project Manifest Schema (v1)

Location: `config/projects.d/<project_id>.yml`

Purpose: declare which resources are readable for a project, with scope and limits. Paths live only in the manifest. Code references resources by name.

### Top-level fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| version | int | yes | Schema version. v1 = 1. |
| project_id | string | yes | Unique identifier for routing and audit. |
| display_name | string | yes | Human-readable name. |
| kind | string | yes | `local_fs` in v1; future: `remote_http`, `ssh_readonly`, etc. |
| enabled | bool | yes | Enable/disable this project. |
| root | string | yes | Project root path (only for `local_fs`). |
| resources | map | yes | Resource declarations (see below). |
| deny | list[glob] | yes | Permanent deny list (sensitive paths). |
| limits | map | yes | Global fallback limits. |
| notes | map | no | Metadata only; not used by logic. |

### Resources

`resources` is a map: `resource_name -> resource_def`.

#### 2.1 type: `file_glob`

Purpose: read a set of files (e.g. `alert_sent_*.jsonl`).

| Field | Required | Description |
| --- | --- | --- |
| type | yes | Fixed value: `file_glob`. |
| base | yes | Directory relative to `root`. |
| glob | yes | Glob pattern. |
| format | yes | `jsonl` or `text` or `json`. |
| max_bytes | yes | Hard cap for total bytes per read. |
| max_lines | yes | Max lines to parse (tail window). |
| freshness_days | no | Default 14; only read recent files. |

Error behavior:
- No matching files: `ok=false`, `reason=file_not_found`.
- Limit exceeded: `ok=false`, `reason=limit_exceeded`.

#### 2.2 type: `dir_glob`

Purpose: traverse files in a directory (e.g. extreme events).

| Field | Required | Description |
| --- | --- | --- |
| type | yes | Fixed value: `dir_glob`. |
| base | yes | Directory relative to `root`. |
| glob | yes | Glob pattern (supports subdirs). |
| max_files | yes | Max files per scan. |
| freshness_days | no | Default 14. |

#### 2.3 type: `pm2_logs`

Purpose: read tail of pm2 logs by process name.

| Field | Required | Description |
| --- | --- | --- |
| type | yes | Fixed value: `pm2_logs`. |
| names | yes | Allowed pm2 process names. |
| max_lines | yes | Max lines per read. |

#### 2.4 type: `pm2_ps`

Purpose: read pm2 process status (status/uptime/restarts/mem).

| Field | Required | Description |
| --- | --- | --- |
| type | yes | Fixed value: `pm2_ps`. |
| names | yes | Allowed pm2 process names. |

### deny (permanent deny rules)

Recommended minimum in v1:
- `.env*`
- `*secrets*`
- `*.key`, `*.pem`
- `id_rsa*`
- `authorized_keys`

Rule: deny has higher priority than allow. If a path hits deny, reject with `reason=denied_by_policy`.

### limits (global fallback)

Apply when a resource omits its own limits.

Recommended values:
- `max_total_bytes`: 800k
- `max_total_lines`: 800
- `max_total_files`: 500

---

## Policy Schema (v1)

Location: `config/policy.yml`

Purpose: define who can do what (capabilities) where (channel/chat/user), with gating, rate limits, and output limits.

### Top-level fields

| Field | Required | Description |
| --- | --- | --- |
| version | yes | Schema version. v1 = 1. |
| enabled | yes | Master switch. |
| principals | yes | Identity definitions (owner/allowlist). |
| capabilities | yes | Supported capability names. |
| default | yes | Default policy (deny by default). |
| rules | yes | Rule list. |

### principals

Minimal v1 fields:
- `owner.telegram_user_id`: owner user id for group gating (`from.id`).
- `owner.telegram_owner_chat_id`: owner private chat id (optional).
- `allowlist.telegram_user_ids`: future expansion.
- `allowlist.telegram_chat_ids`: future expansion.

### capabilities

Recommended v1 list:
- `alerts.explain`
- `ops.status`
- `ops.logs`
- `ops.ps`

Future (optional):
- `repo.read_file`
- `repo.search`
- `autofix.run_report`

### rules

Each rule:

| Field | Required | Description |
| --- | --- | --- |
| name | yes | Rule name. |
| match | yes | Match conditions (channel/chat/user). |
| allow | yes | Allowed capabilities list. |
| require | no | Gating conditions (mention/reply). |
| rate_limit | no | rpm throttle. |
| output_limits | no | `max_lines` / `max_chars`. |
| deny_message | no | Message on deny. |

`match` supports (v1):
- `channel`: `telegram`
- `chat_id`: string
- `chat_type`: `private` | `group` | `supergroup`
- `user_id`: string

`require` supports (v1):
- `mention_bot_for_explain`: bool
- `reply_required_for_explain`: bool
- `mention_bot_for_ops`: bool

Current behavior mapping:
- Group explain requires mention + reply.
- Group ops commands do not require mention.

### Policy decision output (recommended)

Internal policy evaluation should return:

```
{
  "allowed": true,
  "deny_message": "...",
  "limits": { "rpm": 30, "max_lines": 80, "max_chars": 8000 }
}
```

### Error codes (recommended)

Use short, consistent codes across providers and policy:
- `not_allowed`
- `missing_mention`
- `missing_reply`
- `resource_not_found`
- `denied_by_policy`
- `limit_exceeded`
- `provider_unavailable`

---

## Why this matters

With these schemas, onboarding a new project only requires:
1) Add `config/projects.d/<new_project>.yml`.
2) Add a policy rule granting access.
3) No code changes (or only provider additions).
