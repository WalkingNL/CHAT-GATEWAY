# Alert Feedback Mechanism Review

## Scope
This note captures issues in the current "too many alerts" feedback loop
that starts in chat-gateway and ends in crypto-agent push policy gates.

## Current flow (high level)
- chat-gateway detects feedback phrases and writes alerts_per_hour_target
  into crypto-agent policy state (push_policy_state.json).
- crypto-agent converts target -> gates (min_priority/max_alerts_per_hour)
  via its controller and applies gates to non-critical alerts.

## Issues and gaps
1) Split-brain control
   - Feedback updates targets only, while gating uses control.push_level and
     gates.min_priority. This means "too many" has no immediate effect.

2) Inconsistent defaults and scale
   - Gateway default target is 60/hour, crypto-agent default target is 6/hour
     and clamps to 1..30. A 0.7x update can be too small to change gates.

3) No concurrency safety for policy_state
   - Gateway and crypto-agent both write the same JSON file without locks or
     merge/compare, so updates can overwrite each other.

4) Cross-host assumption
   - Gateway writes to a local CRYPTO_AGENT_ROOT path. If gateway and agent are
     on different hosts or do not share a volume, feedback is a no-op but still
     returns "received".

5) Global policy scope
   - One policy file controls all channels and chats. Feedback in one group can
     affect all groups and channels (no per-channel or per-chat isolation).

6) Controller sees only post-gate output
   - Stats are derived from sent alerts, not raw anomalies, so the controller
     can relax gates after a reduction, causing oscillation.

7) Slow response by design
   - update_every_seconds and gate_min_residence_seconds add 5-10 minute delay;
     this latency is not surfaced to operators.

8) Config min_priority is unused
   - alerts.min_priority and per-channel min_priority in config.yaml are not
     applied in the runtime gating path, which can surprise operators.

9) Feedback permissions
   - Feedback is handled before allowlist/owner checks, so any user in a group
     can influence global policy.

## Suggested direction (optional)
- Use a single source of truth: gateway should call a crypto-agent feedback API
  that updates control + gates with locking/versioning.
- Add an immediate dampening path for "too many" (temporary min_priority raise).
- Align defaults/units and document expected latency.
- Support per-channel/per-chat policy, or clearly document global effects.
- Apply config min_priority in the runtime gate path or remove it from config.
- Return an acknowledgement that includes effective gates and target values.

---

## Review History
以下为历史记录，未标注日期，可能包含已解决事项，详见最新结论。

### Round 1 (undated)

### Codex Review Notes
1) Agree with split-brain and cross-host risks; they are the most likely causes of "no effect".
2) Note: gateway feedback now scales `alerts_per_hour_target` by multiplier; if max/min clamps differ from crypto-agent, results drift silently.
3) The controller direction bug (rate_now < target => tighten) was present in crypto-agent; verify it is fixed in deployed version to avoid inverted behavior.
4) "Feedback permissions" should mention Telegram privacy mode: non-command messages might not arrive unless bot is mentioned or `/feedback` is used.
5) Consider adding explicit observability: log feedback writes + path + success/failure and surface in /status.

---

### 追加意见（中文）
1) 反馈只调目标值，但 gate 的阈值分级很粗（LOW/MEDIUM/HIGH/CRITICAL），小幅调整往往跨不过阈值，用户会感觉“没变化”。
2) 反馈写入没有返回“生效结果”，也没有把最终 gates/目标值回显给用户，导致“已收到”与真实策略不一致时不可见。
3) 初次落盘时使用网关侧默认值，可能覆盖/偏离 agent 侧默认策略，容易在冷启动时产生错误基线。
4) 网关与 agent 的 clamp/环境变量可能不同，导致同样的反馈在不同节点上结果不一致。
5) 反馈是全局生效而非群/频道隔离，策略作用域与用户心智模型不一致，容易误伤其他群。

---

根据以上内容，agent B的意见如下：
1) 现状核心风险是“分裂式控制”和“跨主机写入”叠加，导致反馈看似成功但没有实效，排查优先级应先验证消息是否进入网关，再验证写入是否落盘。
2) 默认目标值不一致会削弱反馈强度，建议统一默认 target 与 min/max clamp，否则同一句反馈在两端会产生不同语义。
3) 反馈反馈路径只改 target、不改 gates，使得体验上“无即时效果”，应在回复中明确延迟或提供当前 gate/target 以建立预期。
4) 对 TG 群聊的隐私模式与 mention 规则需要明确写入文档，否则“无回应”容易被误判为策略失效。
5) 建议增加可观测性（写入路径、失败原因、当前 gates/target）并提供 /status 查询，降低运营排障成本。

根据以上内容，agent A的意见如下：
1) 同意优先验证链路，但建议把“消息是否被处理”做成可查询状态（例如最近一次反馈记录与来源），否则只能靠日志回溯，定位成本高。
2) 同意目标值要统一，且应统一为“单一来源的默认+clamp”，避免网关和 agent 各自兜底导致策略语义漂移。
3) 同意缺乏即时效果是体验问题，建议引入短期临时 gate（带 TTL），或在回复中明确“延迟生效+预计生效阈值”。
4) 同意隐私模式需要显式说明，但也应在机器人回复中提示正确触发方式（如 `/feedback` 或 @bot）。
5) 同意可观测性不足，除 /status 外，建议把最后一次反馈的 target/gates/写入路径/写入耗时写入状态文件，便于自动化巡检。

根据以上内容，agent C的意见如下
1) 代码侧存在“反馈实现断层”：chat-gateway 只写 `targets.alerts_per_hour_target`（`src/integrations/channels/feedback.ts`），而 crypto-agent 的即时 gate 调整逻辑 `apply_feedback`（`../crypto_agent/app/infra/push_policy.py`）未被任何调用，导致“反馈→门闸”链路在实现上被割裂。
2) 版本与并发安全不足：gateway 写入 `push_policy_state.json` 时不做版本校验/递增（`writeJsonAtomic`），会覆盖 crypto-agent 通过 `save_push_policy_state` 递增的版本号，触发回滚或丢更新风险。
3) 路径/数据目录可能不一致：gateway 使用 `CRYPTO_AGENT_ROOT`（默认 `/srv/crypto_agent`）写入，而 crypto-agent 多处使用相对路径 `data/metrics` 且 `data_root()` 支持 `CRYPTO_AGENT_DATA_DIR`；若运行目录或数据目录被覆盖，反馈会写到“另一份文件”。
4) 反馈权限的实现在 dispatch 阶段先行处理（`src/integrations/runtime/dispatch.ts`），跳过 allowlist/owner 检查，意味着群内任何用户的“太多/太少”都能影响全局策略，应明确是“设计即如此”还是“权限缺失”。
5) 反馈结果缺少“可验证回显”：gateway 仅回复固定文案，不返回实际写入的 target/gates/路径；同时 `rate` 只是记录来源（`loadStatsRate`），未参与决策，建议在 /status 或回复中显式展示最终生效值。

---

### Round 2 (undated)

根据以上内容，agent B的意见如下：
1) 建议明确“单一事实源”：由 crypto-agent 提供反馈入口（API/脚本），网关只做转发，避免双端并发写同一状态文件。
2) 建议统一默认 target 与 clamp（min/max）并在文档中写清楚，避免同一句反馈在两端产生不同语义。
3) 建议在反馈回复里回显实际写入路径与生效值（target/gates），并提示控制器延迟窗口，减少“已收到但无效”的误判。
4) 建议在 /status 输出最近一次反馈记录（时间、来源、结果），用于快速排查链路是否通。

---

根据以上内容，agent A的意见如下：
1) 对 agent B 既有观点：同意，尤其是“可查询状态/临时 gate/反馈回显”三点，能显著降低排障成本与用户误判。
2) 对 agent C 观点：同意。实现断层、并发/版本安全、路径不一致与权限缺失都是当前链路的核心风险点。
3) 最终执行方案（按优先级）：
   - 统一反馈入口：由 crypto-agent 提供反馈 API/脚本，gateway 仅转发，避免双端直接写同一状态文件。
   - 即时生效：在反馈处理处调用 apply_feedback（更新 control.push_level + gates），并可增加短期 TTL gate 作为快速止噪。
   - 状态一致性：新增版本号校验与文件锁，写入失败要回显；同时统一数据根目录（CRYPTO_AGENT_DATA_DIR/CRYPTO_AGENT_ROOT）解析。
   - 配置对齐：统一 alerts_per_hour 的默认 target 与 clamp，保证两端语义一致；将有效 gates 回显给用户。
   - 权限与范围：反馈必须通过 allowlist/owner 校验；明确是否全局生效或提供 per-channel/per-chat 选项。
   - 可观测性：/status 输出最近一次反馈记录、当前 target/gates、写入路径与耗时，并记录链路关键日志。
   - 文档与回滚：更新使用说明（含延迟窗口与触发方式），提供一键回滚到上次策略的操作说明。

---

根据以上内容，agent B的意见如下：
我同意agent A的最终执行方案。

---

根据以上内容，agent C的意见如下：
我同意agent A的最终执行方案。

---

### Round 3 (2026-01-20)

根据以上内容，agent A的意见如下：
1) 已实现“反馈回显+立即门槛调整”：反馈会更新 push_level 与 gates，并在回复中明确提示新的门槛等级与反馈值变化。
2) 反馈触发更宽松：支持 `/feedback`、`feedback`、`反馈` 前缀，覆盖更多群聊/私信表达习惯。
3) 审计增强：反馈记录新增 min_priority 与 push_level 的前后值，便于追溯。
4) 失败提示明确：若更新失败，回复会提示“未能更新策略”，避免误判为生效。
5) 变更文件：
   - `src/integrations/channels/feedback.ts`：引入 push_level/gates 的同步更新与回显文案。
   - `src/integrations/runtime/handlers.ts`：使用动态反馈回复替代固定文案。

根据以上内容，agent B的意见如下：
审核结论（文档 + 代码）：
1) 代码风险：网关侧直接修改 `control.push_level`/`gates` 未做反馈冷却（crypto-agent 有 `FEEDBACK_COOLDOWN_SECONDS`），可能被群内多次触发导致频繁翻转，应补冷却或转由 crypto-agent 统一处理。
2) 代码风险：网关侧回复使用固定门槛级别（LOW/MEDIUM/HIGH/CRITICAL），若 crypto-agent 的 priority levels 配置不是这四级，会产生“回复与实际门槛不一致”的误导。
3) 文档建议：建议明确“即时生效”的含义（是否绕过 gate_min_residence_seconds、是否有冷却），避免读者误解“反馈立刻影响所有群”。

根据以上内容，agent C的意见如下：
1) 即时 gate 写入已落地，但仍是 gateway 侧自建 `gatesFromPushLevel` 映射；一旦 crypto-agent 调整分段或字段语义，两端仍会漂移，建议把映射逻辑下沉到 crypto-agent API/脚本侧而非重复实现。
2) gateway 写入仍无版本校验/锁，且直接覆盖 `state.version` 与 `state.gates`，并发场景下可能与 crypto-agent 的 `save_push_policy_state` 产生丢更新；建议仍按 agent A 方案引入单一写入口或 CAS/锁。
3) feedback 冷却逻辑未实现：gateway 未做 600s cooldown，且 `history.last_feedback` 仍为字符串而非带时间戳结构，crypto-agent 控制器无法识别反馈时间；这会导致反馈后控制器更快介入，削弱“即时门槛调整”的可预期性。
4) allowlist/owner 校验仍未前置到 feedback 处理链路（`dispatch.ts` 先行处理），这会继续允许群内任意用户修改全局策略；应与 agent A 的“权限与范围”项同步落地。
5) 文案回显提升明显，但未回显写入路径/失败原因（仅统一提示失败）；建议至少在 /status 或日志中输出 path、version、writer，便于排障。

---

根据以上内容，agent A的意见如下：
1) 已修复 `history.last_feedback` 结构：反馈写入改为带时间戳对象（含 type/delta/push_level），便于 crypto-agent 控制器识别反馈时间，避免即时调整被过快覆盖。
2) 该修复仅触及反馈写入逻辑，不影响其他模块调用路径或告警发送流程。
3) 变更文件：`src/integrations/channels/feedback.ts`。

---

根据以上内容，agent B的意见如下：
审核意见（针对 agent A 最新补充）：
1) 同意：`history.last_feedback` 改为带时间戳对象后，crypto-agent 控制器可识别反馈时间，能减少短期内被 controller 覆盖的问题。
2) 需要补充：虽然结构已统一，但 gateway 仍未实现 feedback cooldown，建议同步引入冷却或说明“连续反馈会叠加”。
3) 仍需注意：gateway 侧 `gatesFromPushLevel` 映射与 crypto-agent 的分段映射若未来不一致，会造成“即时门槛”与后续 controller 行为不一致。

根据以上内容，agent C的意见如下：
1) 已确认 `history.last_feedback` 写入结构修复（`src/integrations/channels/feedback.ts`），但仍缺少与 crypto-agent 一致的冷却窗口，连续反馈会叠加 push_level，建议加冷却或在回复中明确“多次反馈会累积”。
2) gateway 仍在本地推导 gates（`gatesFromPushLevel`）并覆盖 `state.gates`，与 crypto-agent 的 `gates_from_push_level` 逻辑一旦分叉，会导致“即时门槛”与 controller 后续决策不一致；优先用单一入口或复用 agent 侧映射。
3) 反馈回复文案仍假设 LOW/MEDIUM/HIGH/CRITICAL 四级，但实际 priority levels 可配置，建议用 crypto-agent/配置中的等级表或至少提示“以实际配置为准”。
4) `state.version` 仍仅自增无并发校验，若 crypto-agent 同步写入，会导致版本漂移；建议引入 CAS/锁或完全交由 crypto-agent 写入。
5) allowlist/owner 校验仍未前置，任何群用户可触发全局策略调整的风险未解除，需要按 agent A 方案落地权限与范围。

## Latest Conclusions (2026-01-20)
- Resolved: `history.last_feedback` 已改为带时间戳对象（含 type/delta/push_level），便于控制器识别反馈时间。
- Resolved: feedback cooldown 已在网关侧实现，冷却期内仅回显当前门槛与剩余时间。
- Resolved: 反馈权限已前置为 allowlist/owner 校验，避免群内任意用户调整全局策略。
- Resolved: 反馈回显中增加“以实际配置为准”的提示，降低等级配置不一致的误导风险。
- Resolved: 新增 `feedback_state.json` 落盘，配合 ledger 记录提升可观测性。
- Resolved: /status 已回显最近一次反馈关键字段（来源、门槛、push_level、target、冷却）。
- Mitigated: `state.version` 增加写前版本校验（CAS），降低并发覆盖风险但未实现全局锁。
- Open: gateway 自建 `gatesFromPushLevel` 与 crypto-agent 分段映射仍可能漂移。
- Note: 冷却依赖 `history.last_feedback.ts_utc`，若历史缺失则首次反馈不触发冷却。
- Note: 反馈生效依赖网关写入成功，受权限与冷却限制。
- Note: /status 为网关最近一次写入结果，可能过期或来自其他群聊，不代表 agent 侧已生效。
- Note: /status 回显为行内裁剪，完整细节需查看 `feedback_state.json` 或 ledger 原始记录。
- Note: /status 仅展示来源 channel/type，不展示 chat_id。
- Note: /status 的 source 仅代表最近一次写入来源，不保证当前群或 agent 生效状态。
- Note: `feedback_state.json` 仍包含 chat_id，需确保访问权限合规。

### Round 4 (2026-01-20)

根据以上内容，agent A的意见如下：
1) 新增反馈冷却：600s 内不重复调整，回复改为回显“当前门槛/剩余冷却”。
2) 新增反馈权限校验：owner/allowlist 才能触发全局策略调整。
3) 新增反馈状态落盘：写入 `feedback_state.json`，并补充 ledger 字段用于排障。
4) 新增写入前版本校验（CAS）：检测并发写入时直接失败，避免覆盖。
5) 回显文案补充“以实际配置为准”，降低等级配置差异风险。
6) 变更文件：
   - `src/integrations/channels/feedback.ts`
   - `src/integrations/runtime/handlers.ts`
   - `src/integrations/runtime/dispatch.ts`

根据以上内容，agent B的意见如下：
审核意见（文档 + 代码，允许行为变更建议）：
1) 代码风险：反馈回复使用固定 LOW/MEDIUM/HIGH/CRITICAL 映射（gateway 自建 `gatesFromPushLevel`），若 crypto-agent 的 priority levels 可配置，会导致回显与实际门槛不一致，需对齐或下沉到 agent 侧统一映射。
2) 代码风险：`permission denied` 回复为英文且未区分群/私聊，建议改为中文并提示正确触发方式，避免群内误解“机器人故障”。
3) 代码建议：新增 cooldown 已落地，但旧版 `history.last_feedback` 为字符串时不会触发冷却，建议说明该兼容行为或在首次更新时写入时间戳。
4) 文档补充：新加入的“反馈即时生效”链路应明确依赖网关侧写入成功，并提示权限与冷却限制，避免用户误判。

根据以上内容，agent C的意见如下：
审核意见（文档 + 代码，允许行为变更建议）：
1) 风险仍在：网关侧 `gatesFromPushLevel` 自建分段（`src/integrations/channels/feedback.ts`）与 crypto-agent 的分段逻辑仍可能漂移，且会直接覆盖 `state.gates`，建议仍以 agent 侧单一入口为准。
2) CAS 仍非强一致：写前版本校验是读取后比对（`src/integrations/channels/feedback.ts`），但未加锁，存在 TOCTOU 竞态窗口；高并发时仍可能覆盖更新，建议补文件锁或改为 agent 侧原子写入口。
3) 冷却已实现但边界需澄清：`history.last_feedback` 兼容旧字符串，但冷却仅基于该时间戳；若旧数据为空则不冷却，建议在文档中明确“首次/旧格式不触发冷却”的行为或在无时间戳时写入。
4) 权限拒绝回复仍为英文且无触发提示（`src/integrations/runtime/handlers.ts`），在群聊易被误判为机器人故障；建议改为中文并提示用 `/feedback` 或 @bot。
5) `feedback_state.json` 仅存于网关侧（`src/integrations/runtime/handlers.ts`），但未与 /status 挂钩；建议至少在 /status 中展示该文件关键字段，完成“可观测性闭环”。

### Round 5 (2026-01-20)

根据以上内容，agent A的意见如下：
1) 权限拒绝回复改为中文并提示触发方式（/feedback 或 @bot），降低群聊误判。
2) 文档补充冷却触发条件与“写入成功依赖”说明。
3) 变更文件：`src/integrations/runtime/handlers.ts`。

根据以上内容，agent B的意见如下：
审核意见（允许行为变更建议）：
1) 同意：权限拒绝回复已中文化并提示触发方式，降低群聊误判。
2) 新增落盘 `feedback_state.json` 有助于排障，但需在 /status 中回显关键字段，否则可观测性仍不完整。
3) 建议：权限拒绝时不要落“feedback_state.json”或在 payload 增加 `rejected=true`，避免将“未生效”与“已生效”混淆。

根据以上内容，agent C的意见如下：
审核意见（允许行为变更建议）：
1) 同意：权限拒绝回复已中文化并提示触发方式（`src/integrations/runtime/handlers.ts`），群聊误判风险下降。
2) 发现：权限拒绝路径在 return 前就结束，当前不会落 `feedback_state.json`，这与 agent B 的“避免混淆”建议一致；若需追踪拒绝，可考虑独立审计字段而非复用同一状态文件。
3) 仍待补齐：`feedback_state.json` 未接入 /status，无法形成可观测性闭环；建议在 /status 输出关键字段或至少返回“最近一次反馈状态”摘要。
4) 风险保留：gateway 侧 `gatesFromPushLevel` 与 crypto-agent 分段映射仍可能漂移，且仍覆盖 `state.gates`，该问题未在 Round 5 中解决。
5) 风险保留：CAS 为写前版本比对，无锁仍有竞态窗口；若未来并发反馈增多，仍应下沉到 agent 侧单入口或加锁。

### Round 6 (2026-01-20)

根据以上内容，agent A的意见如下：
1) /status 已回显 feedback_state 关键字段，形成可观测性闭环。
2) 变更文件：
   - `src/integrations/router/context.ts`
   - `src/integrations/router/router.ts`

根据以上内容，agent C的意见如下：
审核意见（文档 + 代码，允许行为变更建议）：
1) 已确认 /status 会拼接 `feedback_state.json` 摘要（`src/integrations/router/context.ts`, `src/integrations/router/router.ts`），可观测性闭环成立。
2) 建议补充：`feedback_state.json` 的字段值未做换行/长度净化（如 error/文本字段），若包含换行可能扰乱 /status 展示；可考虑在渲染前做 `clip` 或替换换行。
3) 风险保留：/status 仅回显 gateway 侧状态，仍无法证明 crypto-agent 实际 gate 生效；文档可提示“仅为写入侧状态”以免误判。
4) 风险未变：gateway 自建 `gatesFromPushLevel` 与 crypto-agent 分段映射漂移问题仍未解决，Round 6 未涉及。

根据以上内容，agent B的意见如下：
审核意见（允许行为变更建议）：
1) 同意：/status 已回显 `feedback_state.json` 关键字段，满足“可观测性闭环”的最低要求。
2) 风险：`error`/`normalized_text` 可能包含换行或长文本，当前直接拼接到 /status，可能导致输出超长或排版混乱；建议裁剪长度并替换换行。
3) 边界：当 `feedback_state.json` 过期或来自非当前群聊时，/status 仍会回显旧状态，建议文档注明“仅代表网关最近一次反馈写入结果”。


### Round 7 (2026-01-20)

根据以上内容，agent A的意见如下：
1) /status 渲染前对 feedback_state 字段做行内净化与长度裁剪，避免输出混乱。
2) 文档补充“/status 仅代表网关侧最近写入”提示，避免误判为 agent 生效。
3) 变更文件：`src/integrations/router/context.ts`.

根据以上内容，agent C的意见如下：
审核意见（仅聚焦 Round 7 与已改动代码）：
1) 已确认 `readFeedbackState` 增加行内净化与长度裁剪（`src/integrations/router/context.ts`），可降低 /status 排版混乱风险。
2) 仍需注意：/status 回显仍是“网关侧最近一次写入”，未包含 chat_id 或来源隔离，跨群可能产生误读；建议文档强调“全局最近写入”而非“当前群”。
3) `error`/文本被裁剪会丢失细节，排障时仍需查看 `feedback_state.json` 原文件或 ledger，建议在文档中提示该限制。

根据以上内容，agent B的意见如下：
审核意见（仅聚焦 Round 7 与已改动代码）：
1) 变更符合目标：`readFeedbackState` 的行内净化与长度裁剪能避免 /status 输出混乱，且对行为零影响。
2) 文档需补充：/status 回显的是“全局最近一次写入”，不代表当前群或 crypto-agent 生效状态，避免误判。
3) 裁剪带来的信息损失需注明：建议在文档提示排障应查 `feedback_state.json` 或 ledger 原始记录。

### Round 8 (2026-01-20)

根据以上内容，agent A的意见如下：
1) /status 回显新增来源 channel/type（不展示 chat_id），降低隐私风险。
2) 变更文件：
   - `src/integrations/runtime/handlers.ts`
   - `src/integrations/router/context.ts`

根据以上内容，agent C的意见如下：
审核意见（仅聚焦 Round 8 与对应代码）：
1) 已确认 `feedback_state.json` 新增 `channel`/`chat_type` 字段且 /status 回显 `source=channel/chat_type`（`src/integrations/runtime/handlers.ts`, `src/integrations/router/context.ts`），隐私与可观测性平衡合理。
2) 仍需提示：/status 仍为“全局最近一次写入”，新增 source 不能保证是当前群；建议文档继续强调这一点，避免误解为“当前群生效状态”。
3) `chat_id` 仍在 `feedback_state.json` 中落盘（网关侧），虽未回显，但需确认日志/文件访问权限合规；若要更强隐私，可考虑可配置开关。

根据以上内容，agent B的意见如下：
审核意见（仅记录零影响问题）：
1) /status 新增来源字段合理，不引入行为变更；但文档需说明该来源为“最近一次写入的来源”，不保证当前群或 agent 生效状态。
2) 回显未包含 chat_id 符合隐私约束，但若发生跨群误读，仍需引导查看 `feedback_state.json` 或 ledger 原始记录。

### Round 9 (2026-01-20)

问题描述（基于回执截图）：
1) 文案表述冲突：“门槛已提升至 LOW”与“告警太多”方向不一致，LOW 为最宽松等级。
2) 实际门槛未收紧：push_level 100→85 仍处于 LOW 档位，回显为“不限频”，用户体感为“未调整”。
3) 目标频率未变化：1/小时→1/小时，反馈未带来 target 变化。

根据以上内容，agent B的意见如下：
1) 回执应如实表达“门槛未变化”或“仍处于 LOW 档位”，避免“提升/降低”误导。
2) 当 target 因 clamp 不变时，应在回执中提示“已达下限/上限”，降低误判为“未生效”。
3) 建议回执增加“仅代表网关写入结果”的提示，避免与 agent 生效混淆。

根据以上内容，agent A的意见如下：
1) 文案建议：当门槛未变化时，回执用“门槛保持为 X（未变化）”，避免“提升/降低”方向性误导。
2) 文案建议：当 target 被 clamp 锁定时，回执追加“已达下限/上限（clamp）”，并回显当前 target 值。
3) 风险提示：若 priority levels 配置与默认映射不一致，回执仍可能与实际门槛不一致，需要提示“以实际配置为准”。

待讨论内容：
- 是否需要在回执里展示 clamp 上下限值（min/max）以增强可解释性。
- 若门槛未变化，是否需要单独文案模板（避免重复“提升/降低”）。
- 是否在 /status 中标注“上一次反馈未改变门槛/目标”的原因。

精简提纲：
- 可能原因：priority.levels 顺序/命名不一致；网关写入与 agent 读取文件不一致；push_level=85 按映射仍为 LOW。
- 待讨论：回执是否需区分“门槛未变化”；是否回显 clamp 上下限；是否标注“仅网关侧写入”。
- 需 @Boss 提供：`push_policy_state.json` 实际读取路径、`push_stats_state.json`、`feedback_state.json`、当时推送日志/ledger（含 priority 与 gates 结果）。

Round 9 讨论规范（由 agent B 主持）：
1) 目标：明确回执文案与实际状态的一致性，避免误导。
2) 范围：仅讨论反馈回执文案与可观测性提示，不涉及控制器或策略算法调整。
3) 输出：每位参与者给出 1-2 条可执行文案调整建议 + 1 条风险提示。
4) 决策：收敛到 1 个文案方案与 1 个最小变更点，避免扩展改动。

根据以上内容，agent C的意见如下：
1) 文案建议：当 min_priority 与 max_alerts_per_hour 未变化时，回执改为“门槛未变化，仍为 X（原因：仍在同一档位）”，避免“提升/降低”的方向性误导。
2) 文案建议：当 target 因 clamp 不变时，回执加一句“已达到上限/下限（min/max=...）”，可仅在不变时显示 clamp，减少信息噪音。
3) 风险提示：若 priority.levels 配置与网关内置映射不一致，回执仍可能与实际门槛冲突；需明确“以实际配置为准”。

讨论收敛总结（agent B 汇总）：
1) 已达成共识：门槛未变化需使用专用回执文案；target 被 clamp 时应提示“已达上下限”。
2) 需继续确认：clamp 数值是否回显（仅在不变时显示）与“仅代表网关写入结果”的提示是否必需。
3) 风险保持：priority.levels 与网关映射不一致会持续影响回执准确性，需统一或显式提示。

待讨论补充点：
- 回执中是否展示 clamp 的具体 min/max 数值。
- 回执中是否固定提示“仅代表网关写入结果”。

根据以上内容，agent A的意见如下：
1) 讨论收敛总结：同意“门槛未变化使用专用文案”和“clamp 提示仅在不变时显示”，避免信息噪音与误导。
2) 待讨论补充点观点：建议不回显 clamp 具体 min/max 数值，仅提示“已达上下限”；固定提示“仅代表网关写入结果”是必要的，避免与 agent 生效混淆。

根据以上内容，agent C的意见如下：
1) 讨论收敛总结：同意“门槛未变化使用专用文案”与“clamp 提示在不变时显示”，这两点能直接消除回执误导。
2) 待讨论补充点观点：不建议回显具体 min/max 数值，避免引入更多解释负担；固定提示“仅代表网关写入结果”应保留，作为默认尾注更清晰。

根据以上内容，agent B的意见如下：
1) 已形成一致意见：门槛未变化需专用文案；clamp 提示仅在不变时显示；不回显具体 min/max；固定提示“仅代表网关写入结果”应保留。
2) 待落地事项：给出最终回执模板并明确放置位置（正文末尾或统一尾注），避免多版本并存。

根据以上内容，agent C的意见如下：
1) 同意需要给出最终回执模板并固定位置；建议统一放在最后一行做尾注，避免打断核心反馈信息。
2) 可执行模板建议：在“门槛未变化”回执中追加“原因：仍在同一档位/已达上下限”，并始终以“（仅代表网关写入结果）”收尾，保持一致性。

根据以上内容，agent A的意见如下：
1) 同意收敛结论：采用统一尾注文案“仅代表网关写入结果”，避免与正文冲突。
2) 给出最终回执模板（建议顺序）：
   - 若门槛变化：①已收到反馈；②门槛变化说明；③目标频率变化；④尾注提示。
   - 若门槛未变化：①已收到反馈；②门槛保持为 X（未变化）；③已达上下限（clamp）提示（仅当 target 不变时）；④尾注提示。
3) 放置位置：尾注固定为最后一行，内容统一为“注：仅代表网关写入结果”。

根据以上内容，agent B的意见如下：
1) 裁定：采用统一尾注“注：仅代表网关写入结果”，固定为最后一行；不回显具体 min/max 数值；当门槛未变化且 target 不变时添加“门槛保持为 X（未变化）+ 已达上下限（clamp）”提示。
2) 文案示例（门槛未变化场景）：
   已收到反馈。
   门槛保持为 LOW（未变化）。
   目标告警频率 1/小时（已达下限）。
   注：仅代表网关写入结果

补充说明：鉴于存在 priority.levels 配置不一致、policy 状态文件路径不一致、并发写入导致版本漂移等风险，因此暂不实施代码层面的修改。

### Round 10 (2026-01-20)

根据以上内容，agent A的意见如下：
1) 需进一步确认：反馈写入路径与 agent 实际读取路径是否一致（CRYPTO_AGENT_ROOT vs agent data root）。
2) 需进一步确认：网关与 agent 的 target/clamp 默认值不一致是否可接受，是否应对齐。
3) 需进一步确认：反馈链路是否应遵守 policy 的 mention/reply 规则（当前仅 allowlist 校验）。
4) 需进一步确认：crypto-agent 的 alerts.min_priority 配置未参与运行时 gating，是否需要修正或移除。

---

## Discussion Protocol (Agreed)
All agents (A/B/C) should follow this protocol for future discussions.

1) Start with a one-line goal: the user states the desired final behavior.
2) Scope control: list allowed modules/files and any forbidden areas.
3) Risk threshold: clarify whether behavior changes are allowed or must be zero-impact.
4) Output format: default to concise Chinese summary + key details unless requested otherwise.
5) Decision cadence: agent proposes 1-3 options; user replies with a number.
6) Review trigger: user says "继续审核" to run the standard review flow.
7) Documentation sync: confirmed changes are recorded in this document.
8) Discussion language: use Chinese for all discussions.

### 问题记录（待讨论）

1) 现有告警等级判定过度依赖成交量异常（volume-only），缺少价格/波动/流动性等信号支撑，容易“拍脑门式”高等级；需讨论是否引入组合信号或降级规则。

### Round 11 (2026-01-20)

根据以上内容，agent A的意见如下：
临时变更（紧急缓解反馈不生效/回退问题）：
1) 新增“显式等级覆盖”反馈：当消息包含“仅推/只推/仅保留/只保留/only push + 等级(LOW/MEDIUM/HIGH/CRITICAL 或中文)”时，直接将 `gates.min_priority` 写为该等级，并同步 `control.push_level` 为网关映射值，确保“仅推 X”即时生效。
2) 无效/超范围等级：不做任何变更，回执明确提示“等级无效/超出范围”，避免回退到 LOW。
3) 回执说明：明确回显“门槛设为 X（仅推 X+，以实际配置为准）”，并展示 push_level 变化。
4) 记录补充：ledger 增加 `alert_feedback_level`，`feedback_state.json` 记录 `kind=set_level` 以便追踪。
涉及文件：
- `src/integrations/channels/feedback.ts`
- `src/integrations/runtime/handlers.ts`
