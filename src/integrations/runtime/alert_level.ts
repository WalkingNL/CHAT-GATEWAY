import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { appendLedger } from "../audit/ledger.js";
import { evaluate } from "../../core/config/index.js";
import type { LoadedConfig } from "../../core/config/types.js";
import { loadAuth } from "../auth/store.js";
import { errorText, rejectText } from "./response_templates.js";
import { INTENT_SCHEMA_VERSION, INTENT_VERSION } from "./intent_schema.js";
import { applyStrategyUpdate, loadPolicyState, resolvePolicyStatePath, resolveRoot, type PolicyState } from "./strategy.js";

type AlertLevelIntent = "alert_level_query" | "alert_level_set";

type HandlerParams = {
  storageDir: string;
  config?: LoadedConfig;
  allowlistMode: "owner_only" | "auth";
  ownerChatId: string;
  ownerUserId: string;
  channel: "telegram" | "feishu";
  chatId: string;
  userId: string;
  isGroup: boolean;
  mentionsBot: boolean;
  send: (chatId: string, text: string) => Promise<void>;
  intent: AlertLevelIntent;
  minPriority?: string;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
  adapterEntry?: boolean;
};

const DEFAULT_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePriority(value: any, fallback: string): string {
  const v = String(value || "").trim().toUpperCase();
  return v || fallback;
}

function loadAgentConfig(root: string): any | null {
  const cfgPath = path.join(root, "config.yaml");
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const raw = fs.readFileSync(cfgPath, "utf-8");
    const data = YAML.parse(raw);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function priorityOrder(levels: string[]): Map<string, number> {
  const order = new Map<string, number>();
  levels.forEach((lvl, idx) => order.set(String(lvl).toUpperCase(), idx));
  return order;
}

function maxPriority(a: string, b: string, order: Map<string, number>): string {
  const ar = order.get(normalizePriority(a, "")) ?? -1;
  const br = order.get(normalizePriority(b, "")) ?? -1;
  if (ar < 0 && br < 0) return "";
  if (ar < 0) return normalizePriority(b, "");
  if (br < 0) return normalizePriority(a, "");
  return ar >= br ? normalizePriority(a, "") : normalizePriority(b, "");
}

function formatTargets(targets: Record<string, any> | undefined): string {
  if (!targets || typeof targets !== "object") return "目标频率：未知";
  const target = targets.alerts_per_hour_target ?? targets.alerts_per_hour ?? null;
  const min = targets.alerts_per_hour_min ?? null;
  const max = targets.alerts_per_hour_max ?? null;
  if (target == null && min == null && max == null) return "目标频率：未知";
  const parts: string[] = [];
  if (target != null) parts.push(`${target}/h`);
  if (min != null || max != null) {
    parts.push(`min ${min ?? "-"} / max ${max ?? "-"}`);
  }
  return `目标频率：${parts.join(" (")}${parts.length > 1 ? ")" : ""}`;
}

function formatLastFeedback(state: PolicyState): string {
  const feedback = (state.history || {}).last_feedback as any;
  if (!feedback || typeof feedback !== "object") return "最近反馈：无";
  const ts = feedback.ts_utc || feedback.ts || "";
  const kind = feedback.type || feedback.kind || "";
  const delta = feedback.delta != null ? `delta ${feedback.delta}` : "";
  const push = feedback.push_level != null ? `push_level ${feedback.push_level}` : "";
  const parts = [kind, ts].filter(Boolean).join(" @ ");
  const extras = [delta, push].filter(Boolean).join(", ");
  return `最近反馈：${parts || "未知"}${extras ? ` (${extras})` : ""}`;
}

function formatOtherGates(state: PolicyState): string {
  const gates = state.gates || {};
  const parts: string[] = [];
  if (gates.max_alerts_per_hour != null) parts.push(`max_alerts_per_hour=${gates.max_alerts_per_hour}`);
  if (gates.cooldown_minutes != null) parts.push(`cooldown=${gates.cooldown_minutes}m`);
  if (gates.digest_window_minutes != null) parts.push(`digest=${gates.digest_window_minutes}m`);
  if (gates.critical_always_on != null) parts.push(`critical_always_on=${Boolean(gates.critical_always_on)}`);
  if (gates.stablecoin_structural_push != null) parts.push(`stablecoin_structural_push=${Boolean(gates.stablecoin_structural_push)}`);
  if (gates.stablecoin_price_flat_pct != null) parts.push(`stablecoin_price_flat_pct=${gates.stablecoin_price_flat_pct}`);
  return parts.length ? `其他：${parts.join(" / ")}` : "其他：无";
}

function formatChannelThresholds(state: PolicyState, agentCfg: any | null): string {
  const alertsCfg = (agentCfg && typeof agentCfg === "object") ? (agentCfg.alerts || {}) : {};
  const levels = Array.isArray(agentCfg?.priority?.levels) && agentCfg.priority.levels.length
    ? agentCfg.priority.levels
    : DEFAULT_LEVELS;
  const order = priorityOrder(levels.map((v: any) => String(v).toUpperCase()));

  const gates = state.gates || {};
  const globalMin = normalizePriority(gates.min_priority, "");
  const alertsMin = normalizePriority(alertsCfg.min_priority, "");

  const tgCfg = alertsCfg.telegram || {};
  const fsCfg = alertsCfg.feishu || {};
  const tgBase = normalizePriority(tgCfg.min_priority || alertsMin, "");
  const fsBase = normalizePriority(fsCfg.min_priority || alertsMin, "");

  const tgEffective = maxPriority(globalMin, tgBase, order) || tgBase || globalMin;
  const fsEffective = maxPriority(globalMin, fsBase, order) || fsBase || globalMin;

  const tgText = tgBase
    ? `TG=${tgBase}${tgEffective && tgEffective !== tgBase ? `→${tgEffective}` : ""}`
    : `TG=${tgEffective || "未知"}`;
  const fsText = fsBase
    ? `Feishu=${fsBase}${fsEffective && fsEffective !== fsBase ? `→${fsEffective}` : ""}`
    : `Feishu=${fsEffective || "未知"}`;

  return `通道门槛：${tgText}；${fsText}`;
}

function formatPolicyStatus(state: PolicyState, agentCfg: any | null): string {
  const gates = state.gates || {};
  const control = state.control || {};
  const history = state.history || {};
  const globalMin = normalizePriority(gates.min_priority, "未知");
  const pushLevel = control.push_level != null ? String(control.push_level) : "未知";
  const updatedAt = history.last_updated_at_utc || state.updated_at_utc || "";
  const updatedBy = history.last_updated_by || "";

  const lines: string[] = [];
  lines.push(`当前告警推送等级：${globalMin}`);
  lines.push(`push_level：${pushLevel}`);
  if (updatedAt || updatedBy) {
    lines.push(`最近更新：${updatedAt || "未知"}${updatedBy ? ` (${updatedBy})` : ""}`);
  }
  lines.push(formatTargets(state.targets));
  lines.push(formatLastFeedback(state));
  lines.push(formatChannelThresholds(state, agentCfg));
  lines.push(formatOtherGates(state));
  return lines.join("\n");
}

export async function handleAlertLevelIntent(params: HandlerParams): Promise<boolean> {
  const {
    storageDir,
    config,
    allowlistMode,
    ownerChatId,
    ownerUserId,
    channel,
    chatId,
    userId,
    isGroup,
    mentionsBot,
    send,
    intent,
    minPriority,
    requestId,
    requestIdBase,
    attempt,
    adapterEntry,
  } = params;

  const isSet = intent === "alert_level_set";
  const capability = isSet ? "alerts.strategy" : "alerts.query";

  const authState = loadAuth(storageDir, ownerChatId, channel);
  const isOwnerChat = chatId === ownerChatId;
  const isOwnerUser = ownerUserId ? userId === ownerUserId : userId === ownerChatId;
  const allowed =
    allowlistMode === "owner_only"
      ? (isGroup ? isOwnerUser : isOwnerChat)
      : authState.allowed.includes(chatId) || isOwnerUser;

  const evalRes = evaluate(config, {
    channel,
    capability,
    chat_id: chatId,
    chat_type: isGroup ? "group" : "private",
    user_id: userId,
    mention_bot: mentionsBot,
    has_reply: false,
  });
  const isAllowed = (config?.meta?.policyOk === true) ? evalRes.allowed : allowed;
  if (!isAllowed) {
    await send(chatId, evalRes.deny_message || rejectText("未授权操作"));
    appendLedger(storageDir, {
      ts_utc: nowIso(),
      channel,
      chat_id: chatId,
      user_id: userId,
      cmd: isSet ? "alert_level_set_reject" : "alert_level_query_reject",
      request_id: requestId,
      request_id_base: requestIdBase,
      attempt,
      reason: "not_allowed",
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      adapter_entry: adapterEntry,
    });
    return true;
  }

  const policyPath = resolvePolicyStatePath();
  if (!fs.existsSync(path.dirname(policyPath))) {
    await send(chatId, errorText("策略路径不可用，请配置 CRYPTO_AGENT_ROOT"));
    return true;
  }

  if (!isSet) {
    const state = loadPolicyState(policyPath);
    const agentCfg = loadAgentConfig(resolveRoot());
    const message = formatPolicyStatus(state, agentCfg);
    await send(chatId, message);
    appendLedger(storageDir, {
      ts_utc: nowIso(),
      channel,
      chat_id: chatId,
      user_id: userId,
      cmd: "alert_level_query",
      request_id: requestId,
      request_id_base: requestIdBase,
      attempt,
      ok: true,
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      adapter_entry: adapterEntry,
    });
    return true;
  }

  const nextLevel = normalizePriority(minPriority, "");
  if (!nextLevel || !DEFAULT_LEVELS.includes(nextLevel)) {
    await send(chatId, "请指定告警等级（LOW / MEDIUM / HIGH / CRITICAL）。");
    appendLedger(storageDir, {
      ts_utc: nowIso(),
      channel,
      chat_id: chatId,
      user_id: userId,
      cmd: "alert_level_set",
      request_id: requestId,
      request_id_base: requestIdBase,
      attempt,
      ok: false,
      error_code: "missing_level",
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      adapter_entry: adapterEntry,
    });
    return true;
  }

  const res = applyStrategyUpdate({
    action: "set",
    params: { min_priority: nextLevel },
    raw: `intent:set_min_priority ${nextLevel}`,
  });

  if (!res.ok) {
    await send(chatId, errorText(res.message));
    appendLedger(storageDir, {
      ts_utc: nowIso(),
      channel,
      chat_id: chatId,
      user_id: userId,
      cmd: "alert_level_set",
      request_id: requestId,
      request_id_base: requestIdBase,
      attempt,
      ok: false,
      error_code: res.error,
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      adapter_entry: adapterEntry,
    });
    return true;
  }

  const updatedState = loadPolicyState(policyPath);
  const agentCfg = loadAgentConfig(resolveRoot());
  const message = [`已更新告警推送等级：${nextLevel}`, formatPolicyStatus(updatedState, agentCfg)].join("\n");
  await send(chatId, message);
  appendLedger(storageDir, {
    ts_utc: nowIso(),
    channel,
    chat_id: chatId,
    user_id: userId,
    cmd: "alert_level_set",
    request_id: requestId,
    request_id_base: requestIdBase,
    attempt,
    ok: true,
    min_priority: nextLevel,
    changes: res.changes,
    policy_path: res.policyPath,
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    adapter_entry: adapterEntry,
  });
  return true;
}
