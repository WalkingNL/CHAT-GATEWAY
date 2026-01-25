export const INTENT_SCHEMA_VERSION = "v1";
export const INTENT_VERSION = "v1";
export const EXPORT_API_VERSION = "v1";

const PANEL_IDS = [
  "signals.factor_timeline",
  "overview.daily_activity",
  "signals.daily_activity",
] as const;

export type PanelId = typeof PANEL_IDS[number];

const PANEL_ID_SET = new Set<string>(PANEL_IDS);

export type DashboardExportParams = {
  panel_id: PanelId | null;
  window_spec_id: string | null;
  filters: Record<string, any>;
  export_api_version: string;
};

export type IntentParseResult = {
  intent: "dashboard_export";
  params: DashboardExportParams;
  confidence: number;
  schema_version: string;
  intent_version: string;
  raw_query: string;
  missing: string[];
  errors: string[];
  explicit_panel_id: boolean;
  window_spec_id_source: "explicit" | "default" | "missing";
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
  const upper = String(text || "").toUpperCase();
  const direct = upper.match(/\b[A-Z0-9_-]{3,20}USDT\b/);
  if (direct?.[0]) return direct[0];
  if (upper.includes("BTCUSDT")) return "BTCUSDT";
  if (upper.includes("ETHUSDT")) return "ETHUSDT";
  const map = parseSymbolMap();
  for (const [alias, sym] of Object.entries(map)) {
    if (upper.includes(alias)) return sym;
  }
  return null;
}

function parseHours(text: string): number | null {
  const t = String(text || "");
  const hrMatch = t.match(/(?:past|last|recent)?\s*(\d+)\s*(?:h|hr|hour|hours|小时)\b/i);
  if (hrMatch) {
    const n = Number(hrMatch[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (/(?:3|three)\s*(?:d|day|days|天)/i.test(t)) return 72;
  if (/(?:7|seven)\s*(?:d|day|days|周)/i.test(t)) return 168;
  if (/(?:1|one)\s*(?:d|day|days|天)/i.test(t)) return 24;
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
  if (/昨天/.test(t) || /\byesterday\b/i.test(t)) {
    const d = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return formatUtcDate(d);
  }
  return formatUtcDate(now);
}

function isFactorTimeline(text: string): boolean {
  const lower = String(text || "").toLowerCase();
  if (lower.includes("factor") && (lower.includes("timeline") || lower.includes("time line") || lower.includes("time-line"))) {
    return true;
  }
  if (lower.includes("timeline")) return true;
  if (/时间线/.test(text)) return true;
  if (/点状图/.test(text)) return true;
  if (/因子/.test(text) && /线/.test(text)) return true;
  return false;
}

function isDailyActivity(text: string): boolean {
  const lower = String(text || "").toLowerCase();
  if (lower.includes("daily activity")) return true;
  if (lower.includes("activity")) return true;
  if (/活跃/.test(text)) return true;
  if (/活跃度/.test(text)) return true;
  if (/活跃时段/.test(text)) return true;
  return false;
}

function extractPanelId(text: string): string | null {
  const match = String(text || "").match(/\bpanel(?:_id|id)?\s*[:=]\s*([A-Za-z0-9._-]+)\b/i);
  if (!match) return null;
  return match[1];
}

function extractWindowSpecId(text: string): string | null {
  const match = String(text || "").match(/\b(?:window_spec_id|windowspecid|wsid|window_spec)\s*[:=]\s*([A-Za-z0-9._:-]{6,80})\b/i);
  if (!match) return null;
  return match[1];
}

function requireExplicitWindowSpecId(): boolean {
  const raw = String(
    process.env.GW_REQUIRE_EXPLICIT_WINDOW_SPEC_ID
      || process.env.CHAT_GATEWAY_REQUIRE_EXPLICIT_WINDOW_SPEC_ID
      || "",
  ).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(raw);
}

export function allowedPanelIds(): PanelId[] {
  return [...PANEL_IDS];
}

export function isPanelIdAllowed(panelId: string | null): panelId is PanelId {
  if (!panelId) return false;
  return PANEL_ID_SET.has(panelId);
}

export function parseDashboardIntent(
  text: string,
  opts?: { defaultWindowSpecId?: string; now?: Date },
): IntentParseResult | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const errors: string[] = [];
  const missing: string[] = [];
  const explicitPanelId = extractPanelId(raw);
  let panelId: PanelId | null = null;

  if (explicitPanelId) {
    if (isPanelIdAllowed(explicitPanelId)) {
      panelId = explicitPanelId;
    } else {
      errors.push("panel_id_not_allowed");
    }
  }

  if (!panelId && !explicitPanelId) {
    if (isFactorTimeline(raw)) panelId = "signals.factor_timeline";
    else if (isDailyActivity(raw)) panelId = "overview.daily_activity";
  }

  if (!panelId && !explicitPanelId && errors.length === 0) return null;

  const filters: Record<string, any> = {};
  if (panelId === "signals.factor_timeline") {
    const symbol = resolveSymbol(raw);
    if (symbol) {
      filters.symbol = symbol;
    } else {
      missing.push("symbol");
    }
    const hours = parseHours(raw);
    if (hours) filters.window_minutes = Math.round(hours * 60);
  } else if (panelId === "overview.daily_activity" || panelId === "signals.daily_activity") {
    const date = parseDate(raw, opts?.now ?? new Date());
    if (date) filters.date_utc = date;
  }

  const explicitWindowSpecId = extractWindowSpecId(raw);
  const defaultWindowSpecId = String(opts?.defaultWindowSpecId || "").trim();
  const windowSpecId = explicitWindowSpecId || defaultWindowSpecId || null;
  let windowSpecIdSource: "explicit" | "default" | "missing" = "missing";
  if (explicitWindowSpecId) {
    windowSpecIdSource = "explicit";
  } else if (windowSpecId) {
    windowSpecIdSource = "default";
  }

  if (!windowSpecId) {
    missing.push("window_spec_id");
  } else if (windowSpecIdSource === "default" && requireExplicitWindowSpecId()) {
    missing.push("window_spec_id");
  }

  let confidence = 0.35;
  if (panelId) confidence += 0.3;
  if (explicitPanelId) confidence += 0.1;
  if (windowSpecId) confidence += 0.2;
  if (missing.includes("symbol")) confidence -= 0.15;
  if (missing.includes("window_spec_id")) confidence -= 0.2;
  if (errors.length) confidence -= 0.2;
  confidence = Math.max(0, Math.min(0.95, confidence));

  return {
    intent: "dashboard_export",
    params: {
      panel_id: panelId,
      window_spec_id: windowSpecId,
      filters,
      export_api_version: EXPORT_API_VERSION,
    },
    confidence,
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    raw_query: raw,
    missing,
    errors,
    explicit_panel_id: Boolean(explicitPanelId),
    window_spec_id_source: windowSpecIdSource,
  };
}
