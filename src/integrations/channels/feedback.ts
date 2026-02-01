import fs from "node:fs";
import path from "node:path";

export type FeedbackHit = {
  kind: "too_many" | "too_few";
  normalizedText: string;
};

type PriorityLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export const FEEDBACK_REPLY =
  "已收到反馈。\n我会关注近期告警密度，并在不影响异常捕获的前提下做调整。";

const FEEDBACK_TOO_MANY = ["告警太多", "太多了", "一直在刷", "刷屏", "太吵", "好多告警"];
const FEEDBACK_TOO_FEW = ["告警太少", "太安静", "没动静", "怎么没告警", "是不是坏了", "系统坏了"];
const DEFAULT_ALERTS_PER_HOUR_TARGET = Number(process.env.ALERTS_PER_HOUR_TARGET || 60);
const DEFAULT_PUSH_LEVEL = Number(process.env.ALERTS_PUSH_LEVEL_DEFAULT || 50);
const FEEDBACK_PUSH_LEVEL_DELTA = Number(process.env.ALERTS_PUSH_LEVEL_DELTA || 15);
const FEEDBACK_COOLDOWN_SEC = Number(process.env.ALERTS_FEEDBACK_COOLDOWN_SEC || 600);

type PolicyState = {
  version?: number;
  updated_at_utc?: string;
  targets?: {
    alerts_per_hour_target?: number;
    alerts_per_hour_min?: number;
    alerts_per_hour_max?: number;
    [key: string]: any;
  };
  control?: {
    push_level?: number;
    [key: string]: any;
  };
  gates?: {
    min_priority?: string;
    max_alerts_per_hour?: number | null;
    [key: string]: any;
  };
  history?: any;
  history_events?: any[];
  [key: string]: any;
};

export type FeedbackUpdate = {
  path: string;
  statsPath: string;
  prevTarget: number;
  candidate: number;
  nextTarget: number;
  multiplier: number;
  prevPushLevel: number;
  nextPushLevel: number;
  prevMinPriority: string;
  nextMinPriority: string;
  prevMaxAlertsPerHour: number | null;
  nextMaxAlertsPerHour: number | null;
  rate: number;
  rateSource: string;
  clamp?: { min?: number; max?: number };
  policyVersion: number;
  updated: boolean;
  cooldownActive?: boolean;
  cooldownRemainingSec?: number;
};

type FeedbackUpdateContext = {
  updatedBy?: string;
};

export type LevelOverrideHit =
  | { level: PriorityLevel; normalizedText: string }
  | { invalid: true; normalizedText: string };

function stripFeedbackPrefix(rawText: string): string {
  let textNorm = (rawText || "").trim();
  if (!textNorm) return "";

  // feedback command channel (works under Telegram privacy mode in groups)
  textNorm = textNorm.replace(/^(\/feedback(?:@[A-Za-z0-9_]+)?|feedback|反馈)[:：]?\s*/i, "").trim();
  return textNorm;
}

export function detectFeedback(rawText: string): FeedbackHit | null {
  const textNorm = stripFeedbackPrefix(rawText);
  if (!textNorm) return null;

  if (FEEDBACK_TOO_MANY.some((k) => textNorm.includes(k))) {
    return { kind: "too_many", normalizedText: textNorm };
  }
  if (FEEDBACK_TOO_FEW.some((k) => textNorm.includes(k))) {
    return { kind: "too_few", normalizedText: textNorm };
  }
  return null;
}

export function detectLevelOverride(rawText: string): LevelOverrideHit | null {
  const textNorm = stripFeedbackPrefix(rawText);
  if (!textNorm) return null;

  const lower = textNorm.toLowerCase();
  const triggers = ["只推", "仅推", "只保留", "仅保留", "only push", "onlypush"];
  const hasTrigger = triggers.some((t) => lower.includes(t) || textNorm.includes(t));
  if (!hasTrigger) return null;

  const level = parsePriorityLevel(textNorm);
  if (!level) return { invalid: true, normalizedText: textNorm };
  return { level, normalizedText: textNorm };
}

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
  return path.join(resolveRoot(), "data/metrics/push_policy_state.json");
}

function resolveStatsStatePath(): string {
  return path.join(resolveRoot(), "data/metrics/push_stats_state.json");
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
      updated_at_utc: new Date().toISOString(),
      targets: { alerts_per_hour_target: DEFAULT_ALERTS_PER_HOUR_TARGET },
      history: {},
      history_events: [],
    };
  }
  const raw = safeParseJson(fs.readFileSync(filePath, "utf-8"));
  if (raw && typeof raw === "object") return raw as PolicyState;
  return {
    version: 1,
    updated_at_utc: new Date().toISOString(),
    targets: { alerts_per_hour_target: DEFAULT_ALERTS_PER_HOUR_TARGET },
    history: {},
    history_events: [],
  };
}

function loadStatsRate(filePath: string): { rate: number; source: string } {
  try {
    if (!fs.existsSync(filePath)) return { rate: 0, source: "missing" };
    const raw = safeParseJson(fs.readFileSync(filePath, "utf-8"));
    if (!raw || typeof raw !== "object") return { rate: 0, source: "invalid" };

    const ewma = Number((raw as any)?.rate?.alerts_per_hour_ewma);
    if (Number.isFinite(ewma)) return { rate: ewma, source: "rate.alerts_per_hour_ewma" };

    const now = Number((raw as any)?.alerts_per_hour_now ?? (raw as any)?.rate?.alerts_per_hour_now);
    if (Number.isFinite(now)) return { rate: now, source: "alerts_per_hour_now" };

    return { rate: 0, source: "missing_rate" };
  } catch {
    return { rate: 0, source: "error" };
  }
}

function roundTarget(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_ALERTS_PER_HOUR_TARGET;
  return Math.max(1, Number(v.toFixed(2)));
}

function roundPushLevel(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_PUSH_LEVEL;
  const out = Number(v.toFixed(2));
  return Math.max(0, Math.min(100, out));
}

const PRIORITY_ORDER: PriorityLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

function pushLevelForMinPriority(level: PriorityLevel): number {
  if (level === "LOW") return 80;
  if (level === "MEDIUM") return 60;
  if (level === "HIGH") return 40;
  return 0;
}

function normalizePriorityLevel(value: any, fallback: PriorityLevel): PriorityLevel {
  const v = String(value || "").trim().toUpperCase();
  return (PRIORITY_ORDER as string[]).includes(v) ? (v as PriorityLevel) : fallback;
}

function stepPriorityLevel(current: string, kind: FeedbackHit["kind"]): PriorityLevel {
  const cur = normalizePriorityLevel(current, "HIGH");
  const idx = PRIORITY_ORDER.indexOf(cur);
  if (kind === "too_few") {
    return PRIORITY_ORDER[Math.max(0, idx - 1)];
  }
  return PRIORITY_ORDER[Math.min(PRIORITY_ORDER.length - 1, idx + 1)];
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

function parsePriorityLevel(input: string): PriorityLevel | null {
  const text = input || "";
  const lower = text.toLowerCase();
  const matchEnglish = (token: string) => new RegExp(`\\b${token}\\b`, "i").test(text);
  const has = (token: string) => text.includes(token);

  if (matchEnglish("CRITICAL") || matchEnglish("CRIT") || has("严重") || has("最高级") || has("最高") || has("致命")) {
    return "CRITICAL";
  }
  if (matchEnglish("HIGH") || has("高级") || has("高等级") || has("高优先级")) {
    return "HIGH";
  }
  if (matchEnglish("MEDIUM") || has("中等") || has("中等级") || has("中优先级")) {
    return "MEDIUM";
  }
  if (matchEnglish("LOW") || has("低级") || has("低等级") || has("低优先级")) {
    return "LOW";
  }
  return null;
}

function parseUtcTs(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  const s = String(value || "").trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function getLastFeedbackTsMs(history: any): number | null {
  if (!history || typeof history !== "object") return null;
  const last = history.last_feedback;
  if (!last) return null;
  if (typeof last === "string") return parseUtcTs(last);
  if (typeof last === "object") return parseUtcTs((last as any).ts_utc);
  return null;
}

function parseLimit(v: any): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function resolveClamp(targets: Record<string, any>) {
  const min = parseLimit(targets.alerts_per_hour_min ?? process.env.ALERTS_PER_HOUR_MIN);
  const max = parseLimit(targets.alerts_per_hour_max ?? process.env.ALERTS_PER_HOUR_MAX);
  const clamp: { min?: number; max?: number } = {};
  if (min !== null) clamp.min = min;
  if (max !== null) clamp.max = max;
  return clamp;
}

function applyClamp(v: number, clamp: { min?: number; max?: number }): number {
  let out = v;
  if (typeof clamp.min === "number") out = Math.max(clamp.min, out);
  if (typeof clamp.max === "number") out = Math.min(clamp.max, out);
  return out;
}

function writeJsonAtomic(filePath: string, payload: any) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function fmtNumber(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  return v.toFixed(2);
}

export function buildFeedbackReply(kind: FeedbackHit["kind"], update: FeedbackUpdate): string {
  const action = kind === "too_many" ? "提升" : "降低";
  const level = update.nextMinPriority || "HIGH";
  const maxText =
    update.nextMaxAlertsPerHour === null || update.nextMaxAlertsPerHour === undefined
      ? "不限频"
      : `上限 ${fmtNumber(update.nextMaxAlertsPerHour)}/小时`;
  const changed =
    update.prevMinPriority !== update.nextMinPriority ||
    update.prevMaxAlertsPerHour !== update.nextMaxAlertsPerHour;
  const lines: string[] = [];
  if (update.cooldownActive) {
    const remain = Math.max(0, Math.round(update.cooldownRemainingSec || 0));
    lines.push("已收到反馈，但处于冷却期，未重复调整。");
    lines.push(`当前门槛：${level}（仅推送 ${level}+，${maxText}，以实际配置为准）。`);
    lines.push(
      `当前值：push_level ${fmtNumber(update.nextPushLevel)}，` +
        `目标告警频率 ${fmtNumber(update.nextTarget)}/小时。`,
    );
    lines.push(`冷却剩余：${remain}s`);
    return lines.join("\n");
  }
  lines.push("已收到反馈。");
  if (changed) {
    lines.push(`告警等级门槛已${action}至 ${level}（仅推送 ${level}+，${maxText}，以实际配置为准）。`);
  } else {
    lines.push(`门槛保持为 ${level}（未变化，以实际配置为准）。`);
  }
  lines.push(
    `反馈值：push_level ${fmtNumber(update.prevPushLevel)}→${fmtNumber(update.nextPushLevel)}，` +
      `目标告警频率 ${fmtNumber(update.prevTarget)}/小时→${fmtNumber(update.nextTarget)}/小时。`,
  );
  return lines.join("\n");
}

export function buildLevelOverrideReply(level: PriorityLevel, update: FeedbackUpdate): string {
  const targetLevel = level;
  const lines: string[] = [];
  const changed = update.prevMinPriority !== update.nextMinPriority;
  lines.push("已收到反馈。");
  if (changed) {
    lines.push(`门槛已设置为 ${targetLevel}（仅推送 ${targetLevel}+，以实际配置为准）。`);
  } else {
    lines.push(`门槛保持为 ${targetLevel}（未变化，以实际配置为准）。`);
  }
  lines.push(
    `反馈值：push_level ${fmtNumber(update.prevPushLevel)}→${fmtNumber(update.nextPushLevel)}。`,
  );
  return lines.join("\n");
}

export function updatePushPolicyMinPriority(
  level: PriorityLevel,
  ctx?: FeedbackUpdateContext,
): FeedbackUpdate {
  const filePath = resolvePolicyStatePath();
  const statsPath = resolveStatsStatePath();
  const state = loadPolicyState(filePath);

  const targets = typeof state.targets === "object" && state.targets ? state.targets : {};
  const control = typeof state.control === "object" && state.control ? state.control : {};
  const gates = typeof state.gates === "object" && state.gates ? state.gates : {};
  const prevTargetRaw = Number(targets.alerts_per_hour_target ?? DEFAULT_ALERTS_PER_HOUR_TARGET);
  const prevTarget = Number.isFinite(prevTargetRaw) ? prevTargetRaw : DEFAULT_ALERTS_PER_HOUR_TARGET;
  const prevPushLevelRaw = Number(control.push_level ?? DEFAULT_PUSH_LEVEL);
  const prevPushLevel = Number.isFinite(prevPushLevelRaw) ? prevPushLevelRaw : DEFAULT_PUSH_LEVEL;
  const prevDerivedGates = { ...gatesFromPushLevel(prevPushLevel), ...gates };
  const prevMinPriority = normalizePriority(prevDerivedGates.min_priority, "HIGH");
  const prevMaxAlertsPerHour =
    prevDerivedGates.max_alerts_per_hour === undefined ? null : prevDerivedGates.max_alerts_per_hour;
  const { rate, source: rateSource } = loadStatsRate(statsPath);
  const policyVersion = Number.isFinite(Number(state.version)) ? Number(state.version) : 0;

  const nextPushLevel = roundPushLevel(pushLevelForMinPriority(level));
  const nextMinPriority = level;
  const nextMaxAlertsPerHour = prevMaxAlertsPerHour;

  state.targets = targets;
  control.push_level = nextPushLevel;
  state.control = control;
  state.gates = { ...gates, min_priority: nextMinPriority };
  const updatedAt = new Date().toISOString();
  state.updated_at_utc = updatedAt;
  const prevVersion = Number(state.version ?? 0);
  state.version = Number.isFinite(prevVersion) ? prevVersion + 1 : 1;

  const history =
    state.history && typeof state.history === "object" && !Array.isArray(state.history)
      ? state.history
      : {};
  const historyEvents = Array.isArray(state.history_events) ? state.history_events : [];
  historyEvents.push({
    ts_utc: updatedAt,
    kind: "set_level",
    prev_target: prevTarget,
    candidate_target: prevTarget,
    next_target: prevTarget,
    multiplier: 1,
    push_level_prev: prevPushLevel,
    push_level_next: nextPushLevel,
    min_priority_prev: prevMinPriority,
    min_priority_next: nextMinPriority,
    max_alerts_per_hour_prev: prevMaxAlertsPerHour,
    max_alerts_per_hour_next: nextMaxAlertsPerHour,
    rate,
    rate_source: rateSource,
    source: "feedback_level_override",
  });
  history.last_feedback = {
    ts_utc: updatedAt,
    type: "set_level",
    delta: 0,
    push_level: nextPushLevel,
  };
  history.last_reason = "feedback";
  history.last_updated_by = ctx?.updatedBy || "gateway";
  history.last_updated_at_utc = updatedAt;
  if (prevMinPriority !== nextMinPriority) {
    history.last_gate_change_at_utc = updatedAt;
  }
  state.history = history;
  state.history_events = historyEvents;

  if (fs.existsSync(filePath)) {
    const latestRaw = safeParseJson(fs.readFileSync(filePath, "utf-8"));
    const latestVersion = Number((latestRaw as any)?.version ?? policyVersion);
    if (Number.isFinite(latestVersion) && latestVersion !== policyVersion) {
      throw new Error("policy_state_version_mismatch");
    }
  }
  writeJsonAtomic(filePath, state);

  return {
    path: filePath,
    statsPath,
    prevTarget,
    candidate: prevTarget,
    nextTarget: prevTarget,
    multiplier: 1,
    prevPushLevel,
    nextPushLevel,
    prevMinPriority,
    nextMinPriority,
    prevMaxAlertsPerHour,
    nextMaxAlertsPerHour,
    rate,
    rateSource,
    clamp: resolveClamp(targets),
    policyVersion: state.version ?? policyVersion,
    updated: true,
  };
}

export function updatePushPolicyTargets(
  kind: FeedbackHit["kind"],
  ctx?: FeedbackUpdateContext,
): FeedbackUpdate {
  const filePath = resolvePolicyStatePath();
  const statsPath = resolveStatsStatePath();
  const state = loadPolicyState(filePath);

  const targets = typeof state.targets === "object" && state.targets ? state.targets : {};
  const control = typeof state.control === "object" && state.control ? state.control : {};
  const gates = typeof state.gates === "object" && state.gates ? state.gates : {};
  const prevTargetRaw = Number(targets.alerts_per_hour_target ?? DEFAULT_ALERTS_PER_HOUR_TARGET);
  const prevTarget = Number.isFinite(prevTargetRaw) ? prevTargetRaw : DEFAULT_ALERTS_PER_HOUR_TARGET;
  const prevPushLevelRaw = Number(control.push_level ?? DEFAULT_PUSH_LEVEL);
  const prevPushLevel = Number.isFinite(prevPushLevelRaw) ? prevPushLevelRaw : DEFAULT_PUSH_LEVEL;
  const prevDerivedGates = { ...gatesFromPushLevel(prevPushLevel), ...gates };
  const prevMinPriority = normalizePriority(prevDerivedGates.min_priority, "HIGH");
  const prevMaxAlertsPerHour =
    prevDerivedGates.max_alerts_per_hour === undefined ? null : prevDerivedGates.max_alerts_per_hour;
  const { rate, source: rateSource } = loadStatsRate(statsPath);
  const policyVersion = Number.isFinite(Number(state.version)) ? Number(state.version) : 0;

  const lastFeedbackMs = getLastFeedbackTsMs(state.history);
  const nowMs = Date.now();
  if (
    Number.isFinite(FEEDBACK_COOLDOWN_SEC) &&
    FEEDBACK_COOLDOWN_SEC > 0 &&
    lastFeedbackMs !== null &&
    nowMs - lastFeedbackMs < FEEDBACK_COOLDOWN_SEC * 1000
  ) {
    const remaining = FEEDBACK_COOLDOWN_SEC - Math.floor((nowMs - lastFeedbackMs) / 1000);
    return {
      path: filePath,
      statsPath,
      prevTarget,
      candidate: prevTarget,
      nextTarget: prevTarget,
      multiplier: 1,
      prevPushLevel,
      nextPushLevel: prevPushLevel,
      prevMinPriority,
      nextMinPriority: prevMinPriority,
      prevMaxAlertsPerHour,
      nextMaxAlertsPerHour: prevMaxAlertsPerHour,
      rate,
      rateSource,
      clamp: resolveClamp(targets),
      policyVersion,
      updated: false,
      cooldownActive: true,
      cooldownRemainingSec: Math.max(0, remaining),
    };
  }

  const multiplier = kind === "too_many" ? 0.7 : 1.3;
  const clamp = resolveClamp(targets);
  const candidate = prevTarget * multiplier;
  let nextTarget = applyClamp(candidate, clamp);
  nextTarget = roundTarget(nextTarget);

  const delta = kind === "too_many" ? -FEEDBACK_PUSH_LEVEL_DELTA : FEEDBACK_PUSH_LEVEL_DELTA;
  let nextPushLevel = roundPushLevel(prevPushLevel + delta);
  let nextGates = gatesFromPushLevel(nextPushLevel);
  let nextMinPriority = normalizePriority(nextGates.min_priority, prevMinPriority);
  let nextMaxAlertsPerHour =
    nextGates.max_alerts_per_hour === undefined ? null : nextGates.max_alerts_per_hour;
  if (nextMinPriority === prevMinPriority) {
    const steppedLevel = stepPriorityLevel(prevMinPriority, kind);
    if (steppedLevel !== prevMinPriority) {
      const steppedPushLevel = roundPushLevel(pushLevelForMinPriority(steppedLevel));
      if (steppedPushLevel !== nextPushLevel) {
        nextPushLevel = steppedPushLevel;
        nextGates = gatesFromPushLevel(nextPushLevel);
        nextMinPriority = normalizePriority(nextGates.min_priority, prevMinPriority);
        nextMaxAlertsPerHour =
          nextGates.max_alerts_per_hour === undefined ? null : nextGates.max_alerts_per_hour;
      }
    }
  }

  targets.alerts_per_hour_target = nextTarget;
  state.targets = targets;
  control.push_level = nextPushLevel;
  state.control = control;
  state.gates = { ...gates, ...nextGates };
  const updatedAt = new Date().toISOString();
  state.updated_at_utc = updatedAt;
  const prevVersion = Number(state.version ?? 0);
  state.version = Number.isFinite(prevVersion) ? prevVersion + 1 : 1;

  const history =
    state.history && typeof state.history === "object" && !Array.isArray(state.history)
      ? state.history
      : {};
  const historyEvents = Array.isArray(state.history_events) ? state.history_events : [];
  historyEvents.push({
    ts_utc: updatedAt,
    kind,
    prev_target: prevTarget,
    candidate_target: candidate,
    next_target: nextTarget,
    multiplier,
    push_level_prev: prevPushLevel,
    push_level_next: nextPushLevel,
    min_priority_prev: prevMinPriority,
    min_priority_next: nextMinPriority,
    max_alerts_per_hour_prev: prevMaxAlertsPerHour,
    max_alerts_per_hour_next: nextMaxAlertsPerHour,
    rate,
    rate_source: rateSource,
    clamp_min: clamp.min,
    clamp_max: clamp.max,
    source: "feedback",
  });
  history.last_feedback = {
    ts_utc: updatedAt,
    type: kind,
    delta: delta,
    push_level: nextPushLevel,
  };
  history.last_reason = "feedback";
  history.last_updated_by = ctx?.updatedBy || "gateway";
  history.last_updated_at_utc = updatedAt;
  if (prevMinPriority !== nextMinPriority || prevMaxAlertsPerHour !== nextMaxAlertsPerHour) {
    history.last_gate_change_at_utc = updatedAt;
  }
  state.history = history;
  state.history_events = historyEvents;

  if (fs.existsSync(filePath)) {
    const latestRaw = safeParseJson(fs.readFileSync(filePath, "utf-8"));
    const latestVersion = Number((latestRaw as any)?.version ?? policyVersion);
    if (Number.isFinite(latestVersion) && latestVersion !== policyVersion) {
      throw new Error("policy_state_version_mismatch");
    }
  }
  writeJsonAtomic(filePath, state);

  return {
    path: filePath,
    statsPath,
    prevTarget,
    candidate,
    nextTarget,
    multiplier,
    prevPushLevel,
    nextPushLevel,
    prevMinPriority,
    nextMinPriority,
    prevMaxAlertsPerHour,
    nextMaxAlertsPerHour,
    rate,
    rateSource,
    clamp,
    policyVersion: state.version ?? policyVersion,
    updated: true,
  };
}
