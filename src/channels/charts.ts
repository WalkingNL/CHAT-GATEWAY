import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
  outPath: string;
  caption: string;
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

function chartsDir(): string {
  const env = String(process.env.CHART_OUTPUT_DIR || "").trim();
  if (env) return env;
  return "/srv/crypto_agent/data/metrics/on_demand";
}

function buildOutPath(kind: ChartKind, symbol?: string): string {
  const safeSymbol = String(symbol || "na").replace(/[^a-z0-9_-]+/gi, "").toLowerCase();
  const name = `${kind}_${safeSymbol || "na"}_${Date.now()}.png`;
  return path.join(chartsDir(), name);
}

function resolveAllowedOutPath(outPath: string): string {
  const allowlistEnv = String(process.env.CHART_OUTPUT_ALLOWLIST || "").trim();
  const allowlist = allowlistEnv
    ? allowlistEnv.split(",").map(s => s.trim()).filter(Boolean)
    : ["/srv/crypto_agent/data/metrics/on_demand"];

  const normalized = path.resolve(outPath);
  const ok = allowlist.some((allowed) => {
    const base = path.resolve(allowed);
    return normalized === base || normalized.startsWith(`${base}${path.sep}`);
  });
  if (!ok) {
    throw new Error("chart output path not allowed");
  }
  return normalized;
}

export function renderChart(intent: ChartIntent): ChartRenderResult {
  const outPath = resolveAllowedOutPath(buildOutPath(intent.kind, intent.symbol));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const python = "/srv/crypto_agent/venv/bin/python3";

  if (intent.kind === "factor_timeline") {
    if (!intent.symbol) {
      throw new Error("missing symbol");
    }
    const hours = Number(intent.hours || 24);
    const script = "/srv/crypto_agent/tools/render_factor_timeline.py";
    execFileSync(python, [script, "--symbol", intent.symbol, "--hours", String(hours), "--out", outPath], {
      stdio: "pipe",
    });
  } else {
    const date = String(intent.date || formatUtcDate(new Date()));
    const script = "/srv/crypto_agent/tools/render_daily_activity_chart.py";
    execFileSync(python, [script, "--date", date, "--out", outPath], { stdio: "pipe" });
  }

  if (!fs.existsSync(outPath)) {
    throw new Error(`chart output missing: ${outPath}`);
  }

  return { kind: intent.kind, outPath, caption: intent.caption };
}
