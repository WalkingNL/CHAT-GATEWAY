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
    [key: string]: any;
  };
  history?: any[];
  [key: string]: any;
};

export type FeedbackUpdate = {
  path: string;
  prevTarget: number;
  nextTarget: number;
  multiplier: number;
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

export function updatePushPolicyTargets(kind: FeedbackHit["kind"]): FeedbackUpdate {
  const filePath = resolvePolicyStatePath();
  const state = loadPolicyState(filePath);

  const targets = typeof state.targets === "object" && state.targets ? state.targets : {};
  const prevTarget = Number(targets.alerts_per_hour_target ?? DEFAULT_ALERTS_PER_HOUR_TARGET);
  const multiplier = kind === "too_many" ? 0.7 : 1.3;
  const nextTarget = roundTarget(prevTarget * multiplier);

  targets.alerts_per_hour_target = nextTarget;
  state.targets = targets;
  state.updated_at_utc = new Date().toISOString();
  state.version = state.version ?? 1;

  const history = Array.isArray(state.history) ? state.history : [];
  history.push({
    ts_utc: state.updated_at_utc,
    kind,
    prev_target: prevTarget,
    next_target: nextTarget,
    multiplier,
    source: "feedback",
  });
  state.history = history;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");

  return { path: filePath, prevTarget, nextTarget, multiplier };
}
