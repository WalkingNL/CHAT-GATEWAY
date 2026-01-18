import { loadProjectRegistry } from "../runtime/project_registry.js";

export type ChartKind = "factor_timeline" | "daily_activity";

export type ChartIntent = {
  kind: ChartKind;
  symbol?: string;
  hours?: number;
  date?: string;
  caption: string;
};

type ChartRenderResult = {
  kind: ChartKind;
  ok: boolean;
  imagePath?: string;
  sent?: { telegram?: boolean; feishu?: boolean };
  traceId?: string;
  status?: string;
  error?: string;
};

const DEFAULT_SYMBOL_MAP: Record<string, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
};

function parseSymbolMap(): Record<string, string> {
  const raw = String(process.env.CHART_SYMBOL_MAP || "").trim();
  if (!raw) return DEFAULT_SYMBOL_MAP;
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [k, v] = part.split("=").map(s => String(s || "").trim()).filter(Boolean);
    if (k && v) out[k.toUpperCase()] = v.toUpperCase();
  }
  return Object.keys(out).length ? out : DEFAULT_SYMBOL_MAP;
}

function resolveSymbol(text: string): string | null {
  const t = String(text || "").toUpperCase();
  if (t.includes("BTCUSDT")) return "BTCUSDT";
  if (t.includes("ETHUSDT")) return "ETHUSDT";

  const map = parseSymbolMap();
  for (const [alias, sym] of Object.entries(map)) {
    if (t.includes(alias)) return sym;
  }
  return null;
}

function parseHours(text: string): number | null {
  const t = String(text || "");
  const hrMatch = t.match(/(?:过去|最近)?\s*(\d+)\s*(?:小时|h)\b/i);
  if (hrMatch) {
    const n = Number(hrMatch[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  if (/三天|3天|72\s*h/i.test(t)) return 72;
  if (/7天|一周|168\s*h/i.test(t)) return 168;
  if (/最近一天|一天|24\s*h/i.test(t)) return 24;
  return null;
}

function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDate(text: string, now: Date): string {
  const t = String(text || "");
  const match = t.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    if (y >= 1970 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  if (t.includes("昨天")) {
    const d = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return formatUtcDate(d);
  }
  return formatUtcDate(now);
}

function isFactorTimeline(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return t.includes("factor") || t.includes("timeline") || t.includes("时间线") || t.includes("点状图");
}

function isDailyActivity(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return t.includes("daily activity") || t.includes("activity") || t.includes("活跃时段") || t.includes("活跃度图");
}

export function detectChartIntents(text: string, now = new Date()): ChartIntent[] {
  const out: ChartIntent[] = [];
  const wantFactor = isFactorTimeline(text);
  const wantActivity = isDailyActivity(text);
  if (!wantFactor && !wantActivity) return out;

  const symbol = resolveSymbol(text);
  const hours = parseHours(text) ?? 24;
  const date = parseDate(text, now);

  if (wantFactor) {
    const capSymbol = symbol || "UNKNOWN";
    out.push({
      kind: "factor_timeline",
      symbol: symbol || undefined,
      hours,
      caption: `${capSymbol} factor timeline (${hours}h, UTC)`,
    });
  }

  if (wantActivity) {
    out.push({
      kind: "daily_activity",
      date,
      caption: `Daily Activity (UTC, ${date})`,
    });
  }

  return out;
}

type OnDemandConfig = { url: string; token: string };

function resolveOnDemandConfig(projectId?: string): OnDemandConfig {
  const envUrl = String(process.env.CRYPTO_AGENT_ON_DEMAND_URL || "").trim();
  const envToken = String(process.env.CRYPTO_AGENT_ON_DEMAND_TOKEN || "").trim();
  if (envUrl && envToken) return { url: envUrl, token: envToken };

  const registry = loadProjectRegistry();
  const proj = projectId ? registry.projects?.[projectId] : undefined;
  const anyProj = proj ?? registry.projects?.crypto_agent ?? null;
  const onDemand = (anyProj as any)?.on_demand ?? {};

  const url = String(
    onDemand.url
      || (anyProj as any)?.on_demand_url
      || envUrl
      || "http://127.0.0.1:8799",
  ).trim();

  const tokenEnv = String(
    onDemand.token_env
      || (anyProj as any)?.on_demand_token_env
      || "",
  ).trim();
  const token = String(
    (tokenEnv ? process.env[tokenEnv] : "")
      || onDemand.token
      || (anyProj as any)?.on_demand_token
      || envToken
      || "",
  ).trim();

  if (!token) throw new Error("missing on-demand token");
  return { url, token };
}

function buildRenderPayload(intent: ChartIntent, projectId: string | undefined, requestId: string) {
  const payload: any = {
    request_id: requestId,
    kind: intent.kind,
    caption: intent.caption,
    target: projectId ? { project_id: projectId } : undefined,
  };

  if (intent.kind === "factor_timeline") {
    payload.symbol = intent.symbol;
    const hours = Number(intent.hours || 24);
    payload.window_minutes = Math.max(1, Math.round(hours * 60));
  } else {
    payload.date_utc = String(intent.date || formatUtcDate(new Date()));
  }

  return payload;
}

async function postJson(url: string, token: string, body: any): Promise<any> {
  const timeoutMs = Number(process.env.CHAT_GATEWAY_CHART_ACK_TIMEOUT_MS || "2000");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { ok: false, error: "invalid_json", raw: text };
    }
    if (!res.ok) {
      throw new Error(`on_demand_http_${res.status}: ${data?.error || text}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function renderChart(
  intent: ChartIntent,
  opts?: { projectId?: string; requestId?: string },
): Promise<ChartRenderResult> {
  const requestId = String(opts?.requestId || "").trim();
  if (!requestId) throw new Error("missing_request_id");
  const cfg = resolveOnDemandConfig(opts?.projectId);
  const payload = buildRenderPayload(intent, opts?.projectId, requestId);
  const res = await postJson(`${cfg.url}/v1/render`, cfg.token, payload);
  return {
    kind: intent.kind,
    ok: Boolean(res?.ok),
    imagePath: res?.image_path ? String(res.image_path) : undefined,
    sent: res?.sent,
    traceId: res?.trace_id ? String(res.trace_id) : undefined,
    status: res?.status ? String(res.status) : undefined,
    error: res?.error ? String(res.error) : undefined,
  };
}
