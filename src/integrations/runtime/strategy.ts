import fs from "node:fs";
import path from "node:path";
import { appendLedger } from "../audit/ledger.js";
import { errorText, rejectText } from "./response_templates.js";
import type { LoadedConfig } from "../../core/config/types.js";
import { evaluate } from "../../core/config/index.js";
import { INTENT_SCHEMA_VERSION, INTENT_VERSION } from "./intent_schema.js";
import { loadAuth } from "../auth/store.js";

type StrategyCommand = {
  action: "set" | "preview" | "rollback";
  params: Record<string, any>;
  raw: string;
};

type StrategyApplyResult = {
  ok: boolean;
  message: string;
  updated?: boolean;
  error?: string;
  policyPath?: string;
  snapshotPath?: string;
  changes?: Record<string, { prev: any; next: any }>;
  warnings?: string[];
  sync_gates?: boolean;
  strict_sync?: boolean;
  derived_gates?: { min_priority: string; max_alerts_per_hour: number | null } | null;
};

type PolicyState = {
  version?: number;
  updated_at_utc?: string;
  targets?: Record<string, any>;
  control?: Record<string, any>;
  gates?: Record<string, any>;
  history?: Record<string, any>;
  history_events?: any[];
  [key: string]: any;
};

const STRATEGY_PREFIXES = ["/strategy", "策略", "告警策略", "alert_strategy"];
const PRIORITY_LEVELS = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const LOCK_TTL_SEC = Math.max(30, Number(process.env.STRATEGY_LOCK_TTL_SEC || "600"));

function resolveRoot(): string {
  const root = String(process.env.CRYPTO_AGENT_ROOT || "").trim();
  if (root) return root;
  const cwd = process.cwd();
  if (cwd.includes("chat-gateway")) {
    return path.resolve(cwd, "..", "crypto_agent");
  }
  return cwd;
}

function resolvePolicyStatePath(): string {
  const root = resolveRoot();
  return path.join(root, "data/metrics/push_policy_state.json");
}

function resolveStrategyHistoryPath(): string {
  const root = resolveRoot();
  return path.join(root, "data/metrics/strategy_history.jsonl");
}

function resolveStrategyLockPath(): string {
  const policyPath = resolvePolicyStatePath();
  return path.join(path.dirname(policyPath), ".strategy.lock");
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeKey(k: string): string {
  return k.trim().toLowerCase();
}

function parseKeyValuePairs(text: string): Record<string, any> {
  const out: Record<string, any> = {};
  const parts = text.split(/\s+/).filter(Boolean);
  for (const part of parts) {
    const m = part.match(/^([A-Za-z0-9_.-]+)=(.+)$/);
    if (!m) continue;
    out[normalizeKey(m[1])] = m[2];
  }
  return out;
}

function parseJsonPayload(text: string): Record<string, any> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function parseStrategyCommand(text: string): StrategyCommand | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (!STRATEGY_PREFIXES.some(p => lower.startsWith(p.toLowerCase()))) return null;
  let rest = raw;
  for (const prefix of STRATEGY_PREFIXES) {
    if (lower.startsWith(prefix.toLowerCase())) {
      rest = raw.slice(prefix.length).trim();
      break;
    }
  }
  if (!rest) return { action: "preview", params: {}, raw };
  const actionMatch = rest.match(/^(set|apply|preview|rollback)\b/i);
  const actionToken = actionMatch ? actionMatch[1].toLowerCase() : "set";
  const action = actionToken === "apply" ? "set" : (actionToken as StrategyCommand["action"]);
  const payloadText = actionMatch ? rest.slice(actionMatch[0].length).trim() : rest;
  const jsonPayload = parseJsonPayload(payloadText);
  const params = jsonPayload || parseKeyValuePairs(payloadText);
  return { action, params, raw };
}

function safeParseJson(input: string): any | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function loadPolicyState(filePath: string): PolicyState {
  if (!fs.existsSync(filePath)) {
    return {
      version: 1,
      updated_at_utc: nowIso(),
      targets: {},
      control: {},
      gates: {},
      history: {},
      history_events: [],
    };
  }
  const raw = safeParseJson(fs.readFileSync(filePath, "utf-8"));
  if (raw && typeof raw === "object") return raw as PolicyState;
  return {
    version: 1,
    updated_at_utc: nowIso(),
    targets: {},
    control: {},
    gates: {},
    history: {},
    history_events: [],
  };
}

function writeJsonAtomic(filePath: string, payload: any) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function gatesFromPushLevel(pushLevel: number) {
  const v = Number(pushLevel);
  if (Number.isFinite(v)) {
    if (v >= 80) return { min_priority: "LOW", max_alerts_per_hour: null };
    if (v >= 60) return { min_priority: "MEDIUM", max_alerts_per_hour: 20 };
    if (v >= 40) return { min_priority: "HIGH", max_alerts_per_hour: 10 };
  }
  return { min_priority: "CRITICAL", max_alerts_per_hour: 5 };
}

function normalizePriority(value: any, fallback: string): string {
  const v = String(value || "").trim().toUpperCase();
  return v || fallback;
}

function parseNumber(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseBool(value: any): boolean {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  if (!v) return false;
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return false;
}

function normalizeMaxAlerts(value: any): number | null {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (!v || v === "null") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validatePriority(value: any): string | null {
  const v = normalizePriority(value, "");
  if (!v) return null;
  return PRIORITY_LEVELS.has(v) ? v : null;
}

function validateNonNegativeInt(value: any): number | null {
  const n = parseNumber(value);
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function validatePushLevel(value: any): number | null {
  const n = parseNumber(value);
  if (n == null) return null;
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

function persistHistory(pathStr: string, entry: any) {
  fs.mkdirSync(path.dirname(pathStr), { recursive: true });
  fs.appendFileSync(pathStr, JSON.stringify(entry) + "\n", "utf-8");
}

function withFileLock<T>(lockPath: string, fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
  const tryAcquire = (): { ok: true; value: T } | { ok: false; error: string; retry?: boolean } => {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({ ts_utc: nowIso(), pid: process.pid }), "utf-8");
        const value = fn();
        return { ok: true, value };
      } finally {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      }
    } catch (e: any) {
      if (String(e?.code || "") === "EEXIST") {
        return { ok: false, error: "locked", retry: true };
      }
      return { ok: false, error: `策略写入失败：${String(e?.message || e)}` };
    }
  };

  try {
    const first = tryAcquire();
    if (first.ok) return first;
    if (!("retry" in first) || !first.retry) return first;

    try {
      const raw = fs.readFileSync(lockPath, "utf-8");
      const meta = JSON.parse(raw);
      const ts = Date.parse(String(meta?.ts_utc || ""));
      if (Number.isFinite(ts)) {
        const ageSec = (Date.now() - ts) / 1000;
        if (ageSec > LOCK_TTL_SEC) {
          fs.unlinkSync(lockPath);
          console.warn("[strategy][LOCK] stale lock removed", { lockPath, ageSec });
          const retry = tryAcquire();
          if (retry.ok) return retry;
        }
      } else {
        fs.unlinkSync(lockPath);
        console.warn("[strategy][LOCK] invalid lock removed", { lockPath });
        const retry = tryAcquire();
        if (retry.ok) return retry;
      }
    } catch (e: any) {
      return { ok: false, error: `策略锁异常，请手工清理：${lockPath}` };
    }

    return { ok: false, error: "策略文件被占用，请稍后重试" };
  } catch (e: any) {
    return { ok: false, error: `策略写入失败：${String(e?.message || e)}` };
  }
}

function applyStrategyUpdate(cmd: StrategyCommand): StrategyApplyResult {
  const policyPath = resolvePolicyStatePath();
  const historyPath = resolveStrategyHistoryPath();
  const lockPath = resolveStrategyLockPath();
  const strictSync = parseBool(process.env.STRATEGY_STRICT_SYNC);

  if (!fs.existsSync(path.dirname(policyPath))) {
    return { ok: false, message: "策略路径不可用，请配置 CRYPTO_AGENT_ROOT", error: "missing_root" };
  }

  const state = loadPolicyState(policyPath);
  const prevState = JSON.parse(JSON.stringify(state));

  const prevTargets = { ...(state.targets || {}) };
  const prevControl = { ...(state.control || {}) };
  const prevGates = { ...(state.gates || {}) };

  const changes: Record<string, { prev: any; next: any }> = {};
  const warnings: string[] = [];

  const minPriority = cmd.params.min_priority || cmd.params.minpriority || cmd.params.minPriority;
  const maxAlertsPerHour = cmd.params.max_alerts_per_hour ?? cmd.params.max_alerts_per_h;
  const alertsTarget = cmd.params.alerts_per_hour_target ?? cmd.params.alerts_target;
  const pushLevel = cmd.params.push_level ?? cmd.params.pushLevel;
  const syncDerived = parseBool(cmd.params.sync_gates ?? cmd.params.apply_derived ?? cmd.params.sync);

  if (minPriority != null) {
    const next = validatePriority(minPriority);
    if (!next) {
      return { ok: false, message: "min_priority 无效（仅支持 LOW/MEDIUM/HIGH/CRITICAL）", error: "invalid_min_priority" };
    }
    changes.min_priority = { prev: prevGates.min_priority, next };
    state.gates = { ...prevGates, min_priority: next };
  }
  if (maxAlertsPerHour != null) {
    const next = validateNonNegativeInt(maxAlertsPerHour);
    if (next == null) {
      return { ok: false, message: "max_alerts_per_hour 无效（需为非负整数或 null）", error: "invalid_max_alerts_per_hour" };
    }
    changes.max_alerts_per_hour = { prev: prevGates.max_alerts_per_hour, next };
    state.gates = { ...(state.gates || prevGates), max_alerts_per_hour: next };
  }
  if (alertsTarget != null) {
    const next = validateNonNegativeInt(alertsTarget);
    if (next == null) {
      return { ok: false, message: "alerts_per_hour_target 无效（需为非负整数或 null）", error: "invalid_alerts_target" };
    }
    changes.alerts_per_hour_target = { prev: prevTargets.alerts_per_hour_target, next };
    state.targets = { ...prevTargets, alerts_per_hour_target: next };
  }
  if (pushLevel != null) {
    const next = validatePushLevel(pushLevel);
    if (next == null) {
      return { ok: false, message: "push_level 无效（需为 0-100 之间的数字）", error: "invalid_push_level" };
    }
    changes.push_level = { prev: prevControl.push_level, next };
    state.control = { ...prevControl, push_level: next };
  }

  const derived = pushLevel != null ? gatesFromPushLevel(Number(pushLevel)) : null;
  if (derived && syncDerived) {
    const derivedMin = normalizePriority(derived.min_priority, "HIGH");
    if (minPriority != null && normalizePriority(minPriority, "HIGH") !== derivedMin) {
      return { ok: false, message: "min_priority 与 push_level 冲突", error: "conflict_min_priority_push_level" };
    }
    if (maxAlertsPerHour != null && derived.max_alerts_per_hour !== Number(maxAlertsPerHour)) {
      return { ok: false, message: "max_alerts_per_hour 与 push_level 冲突", error: "conflict_max_alerts_per_hour" };
    }
    if (minPriority == null) {
      changes.min_priority = { prev: (state.gates || {}).min_priority, next: derivedMin };
      state.gates = { ...(state.gates || {}), min_priority: derivedMin };
    }
    if (maxAlertsPerHour == null) {
      changes.max_alerts_per_hour = { prev: (state.gates || {}).max_alerts_per_hour, next: derived.max_alerts_per_hour };
      state.gates = { ...(state.gates || {}), max_alerts_per_hour: derived.max_alerts_per_hour };
    }
  }

  if (derived) {
    const derivedMin = normalizePriority(derived.min_priority, "");
    const derivedMax = normalizeMaxAlerts(derived.max_alerts_per_hour);
    const gateState = state.gates || {};
    const gateMin = normalizePriority(gateState.min_priority, "");
    const gateMax = normalizeMaxAlerts(gateState.max_alerts_per_hour);
    const mismatch = gateMin !== derivedMin || gateMax !== derivedMax;
    if (!syncDerived && mismatch) {
      if (strictSync) {
        return {
          ok: false,
          message: "push_level 已更新但 gates 未同步（strict 模式禁止）。请加 sync_gates=1 或显式设置 min_priority/max_alerts_per_hour",
          error: "push_level_gates_diverged",
          policyPath,
          changes,
          sync_gates: syncDerived,
          strict_sync: strictSync,
          derived_gates: { min_priority: derivedMin, max_alerts_per_hour: derivedMax },
        };
      }
      warnings.push("push_level 已更新但 gates 未同步；如需同步请加 sync_gates=1。");
    }
  }

  if (!Object.keys(changes).length) {
    return {
      ok: false,
      message: "未检测到可应用的策略项",
      error: "empty_update",
      sync_gates: syncDerived,
      strict_sync: strictSync,
      derived_gates: derived
        ? { min_priority: normalizePriority(derived.min_priority, ""), max_alerts_per_hour: normalizeMaxAlerts(derived.max_alerts_per_hour) }
        : null,
    };
  }

  const updatedAt = nowIso();
  state.updated_at_utc = updatedAt;
  const prevVersion = Number(state.version ?? 0);
  state.version = Number.isFinite(prevVersion) ? prevVersion + 1 : 1;
  state.history_events = Array.isArray(state.history_events) ? state.history_events : [];
  state.history_events.push({
    ts_utc: updatedAt,
    kind: "strategy_set",
    changes,
  });
  state.history = state.history || {};
  state.history.last_updated_by = "strategy";
  state.history.last_updated_at_utc = updatedAt;

  if (cmd.action === "preview") {
    return {
      ok: true,
      message: "预览完成（未写入）",
      updated: false,
      changes,
      policyPath,
      warnings,
      sync_gates: syncDerived,
      strict_sync: strictSync,
      derived_gates: derived
        ? { min_priority: normalizePriority(derived.min_priority, ""), max_alerts_per_hour: normalizeMaxAlerts(derived.max_alerts_per_hour) }
        : null,
    };
  }

  const snapshot = { ts_utc: updatedAt, prev_state: prevState, next_state: state };
  const lockRes = withFileLock(lockPath, () => {
    persistHistory(historyPath, snapshot);
    writeJsonAtomic(policyPath, state);
  });
  if (!lockRes.ok) {
    return { ok: false, message: lockRes.error, error: "write_locked" };
  }

  return {
    ok: true,
    message: "策略已更新",
    updated: true,
    changes,
    policyPath,
    snapshotPath: historyPath,
    warnings,
    sync_gates: syncDerived,
    strict_sync: strictSync,
    derived_gates: derived
      ? { min_priority: normalizePriority(derived.min_priority, ""), max_alerts_per_hour: normalizeMaxAlerts(derived.max_alerts_per_hour) }
      : null,
  };
}

function rollbackStrategy(): StrategyApplyResult {
  const policyPath = resolvePolicyStatePath();
  const historyPath = resolveStrategyHistoryPath();
  const lockPath = resolveStrategyLockPath();
  if (!fs.existsSync(historyPath)) {
    return { ok: false, message: "未找到策略历史", error: "missing_history" };
  }
  const lines = fs.readFileSync(historyPath, "utf-8").trim().split("\n").filter(Boolean);
  if (!lines.length) {
    return { ok: false, message: "策略历史为空", error: "empty_history" };
  }
  const last = safeParseJson(lines[lines.length - 1]);
  if (!last || typeof last !== "object" || !last.prev_state) {
    return { ok: false, message: "策略历史不完整", error: "invalid_history" };
  }
  const lockRes = withFileLock(lockPath, () => {
    writeJsonAtomic(policyPath, last.prev_state);
  });
  if (!lockRes.ok) {
    return { ok: false, message: lockRes.error, error: "write_locked" };
  }
  return { ok: true, message: "已回滚到上一版本", updated: true, policyPath, snapshotPath: historyPath };
}

function formatChanges(changes?: Record<string, { prev: any; next: any }>) {
  if (!changes || !Object.keys(changes).length) return "无变更";
  const lines: string[] = [];
  for (const [k, v] of Object.entries(changes)) {
    lines.push(`- ${k}: ${String(v.prev)} → ${String(v.next)}`);
  }
  return lines.join("\n");
}

function formatWarnings(warnings?: string[]) {
  if (!warnings || !warnings.length) return "";
  if (warnings.length === 1) return `注意：${warnings[0]}`;
  return ["注意：", ...warnings.map(w => `- ${w}`)].join("\n");
}

export async function handleStrategyIfAny(params: {
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
  text: string;
  send: (chatId: string, text: string) => Promise<void>;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
  adapterEntry?: boolean;
}): Promise<boolean> {
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
    text,
    send,
    requestId,
    requestIdBase,
    attempt,
    adapterEntry,
  } = params;

  const cmd = parseStrategyCommand(text);
  if (!cmd) return false;

  const authState = loadAuth(storageDir, ownerChatId, channel);
  const isOwnerChat = chatId === ownerChatId;
  const isOwnerUser = ownerUserId ? userId === ownerUserId : userId === ownerChatId;
  const allowed =
    allowlistMode === "owner_only"
      ? (isGroup ? isOwnerUser : isOwnerChat)
      : authState.allowed.includes(chatId) || isOwnerUser;

  const evalRes = evaluate(config, {
    channel,
    capability: "alerts.strategy",
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
      cmd: "alert_strategy_reject",
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

  let result: StrategyApplyResult;
  try {
    if (cmd.action === "rollback") {
      result = rollbackStrategy();
    } else {
      result = applyStrategyUpdate(cmd);
    }
  } catch (e: any) {
    result = { ok: false, message: `策略执行异常：${String(e?.message || e)}`, error: "strategy_exception" };
  }

  const reply = result.ok
    ? [result.message, formatChanges(result.changes), formatWarnings(result.warnings)].filter(Boolean).join("\n")
    : errorText(result.message);
  await send(chatId, reply);

  appendLedger(storageDir, {
    ts_utc: nowIso(),
    channel,
    chat_id: chatId,
    user_id: userId,
    cmd: "alert_strategy",
    action: cmd.action,
    request_id: requestId,
    request_id_base: requestIdBase,
    attempt,
    ok: result.ok,
    error_code: result.ok ? undefined : result.error,
    changes: result.changes,
    policy_path: result.policyPath,
    history_path: result.snapshotPath,
    warnings: result.warnings,
    sync_gates: result.sync_gates,
    strict_sync: result.strict_sync,
    derived_gates: result.derived_gates,
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    adapter_entry: adapterEntry,
  });
  return true;
}
