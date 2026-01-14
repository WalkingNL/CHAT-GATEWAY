import fs from "node:fs";
import path from "node:path";

export type FeedbackHit = {
  kind: "too_many" | "too_few";
  normalizedText: string;
};

export const FEEDBACK_REPLY =
  "已收到反馈。\n我会关注近期告警密度，并在不影响异常捕获的前提下做调整。";

const FEEDBACK_TOO_MANY = ["告警太多", "太多了", "一直在刷", "刷屏", "太吵", "好多告警"];
const FEEDBACK_TOO_FEW = ["告警太少", "太安静", "没动静", "怎么没告警", "是不是坏了", "系统坏了"];
const DEFAULT_ALERTS_PER_HOUR_TARGET = Number(process.env.ALERTS_PER_HOUR_TARGET || 60);

type PolicyState = {
  version?: number;
  updated_at_utc?: string;
  targets?: {
    alerts_per_hour_target?: number;
    alerts_per_hour_min?: number;
    alerts_per_hour_max?: number;
    [key: string]: any;
  };
  history?: any;
  [key: string]: any;
};

export type FeedbackUpdate = {
  path: string;
  prevTarget: number;
  nextTarget: number;
  multiplier: number;
  clamp?: { min?: number; max?: number };
};

type FeedbackUpdateContext = {
  updatedBy?: string;
};

export function detectFeedback(rawText: string): FeedbackHit | null {
  let textNorm = (rawText || "").trim();
  if (!textNorm) return null;

  // feedback command channel (works under Telegram privacy mode in groups)
  if (textNorm.startsWith("/feedback")) {
    textNorm = textNorm.replace(/^\/feedback\s*/i, "").trim();
  }
  if (!textNorm) return null;

  if (FEEDBACK_TOO_MANY.some((k) => textNorm.includes(k))) {
    return { kind: "too_many", normalizedText: textNorm };
  }
  if (FEEDBACK_TOO_FEW.some((k) => textNorm.includes(k))) {
    return { kind: "too_few", normalizedText: textNorm };
  }
  return null;
}

function resolvePolicyStatePath(): string {
  const root = String(process.env.CRYPTO_AGENT_ROOT || "").trim() || "/srv/crypto_agent";
  return path.join(root, "data/metrics/push_policy_state.json");
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
      history: [],
    };
  }
  const raw = safeParseJson(fs.readFileSync(filePath, "utf-8"));
  if (raw && typeof raw === "object") return raw as PolicyState;
  return {
    version: 1,
    updated_at_utc: new Date().toISOString(),
    targets: { alerts_per_hour_target: DEFAULT_ALERTS_PER_HOUR_TARGET },
    history: [],
  };
}

function roundTarget(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_ALERTS_PER_HOUR_TARGET;
  return Math.max(1, Number(v.toFixed(2)));
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

export function updatePushPolicyTargets(
  kind: FeedbackHit["kind"],
  ctx?: FeedbackUpdateContext,
): FeedbackUpdate {
  const filePath = resolvePolicyStatePath();
  const state = loadPolicyState(filePath);

  const targets = typeof state.targets === "object" && state.targets ? state.targets : {};
  const prevTarget = Number(targets.alerts_per_hour_target ?? DEFAULT_ALERTS_PER_HOUR_TARGET);
  const multiplier = kind === "too_many" ? 0.7 : 1.3;
  const clamp = resolveClamp(targets);
  let nextTarget = roundTarget(prevTarget * multiplier);
  nextTarget = applyClamp(nextTarget, clamp);

  targets.alerts_per_hour_target = nextTarget;
  state.targets = targets;
  const updatedAt = new Date().toISOString();
  state.updated_at_utc = updatedAt;
  state.version = state.version ?? 1;

  const history =
    state.history && typeof state.history === "object" && !Array.isArray(state.history)
      ? state.history
      : {};
  const events = Array.isArray(history.events)
    ? history.events
    : Array.isArray(state.history)
      ? state.history
      : [];
  events.push({
    ts_utc: updatedAt,
    kind,
    prev_target: prevTarget,
    next_target: nextTarget,
    multiplier,
    clamp_min: clamp.min,
    clamp_max: clamp.max,
    source: "feedback",
  });
  history.events = events;
  history.last_feedback = kind;
  history.last_reason = "feedback";
  history.last_updated_by = ctx?.updatedBy || "gateway";
  history.last_updated_at_utc = updatedAt;
  state.history = history;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");

  return { path: filePath, prevTarget, nextTarget, multiplier, clamp };
}
