export type ParsedAlert = {
  ok: boolean;
  errors: string[];
  symbol: string | null;
  anchor_ms: number | null;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  factor: number | null;
  change_pct: number | null;
  lookback: number | null;
  candle: "closed" | "open" | null;
  event_type: string | null;
  direction: "up" | "down" | "flat" | null;
  window: string | null;
  tier: string | null;
  ts_utc: string | null;
};

function numOrNull(x: any): number | null {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

function parseMsLike(s: string): number | null {
  const cleaned = s.replace(/,/g, "").trim();
  return numOrNull(cleaned);
}

function normalizeDirection(raw: string): "up" | "down" | "flat" | null {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  if (["up", "上行", "上涨"].includes(s)) return "up";
  if (["down", "下行", "下跌"].includes(s)) return "down";
  if (["flat", "横盘", "震荡"].includes(s)) return "flat";
  return null;
}

function normalizeEventType(raw: string): string | null {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return null;
  if (!/^[-A-Z0-9_]+$/.test(s)) return null;
  return s;
}

function parseUtcMinute(text: string): { ts_utc: string; ms: number } | null {
  const m = text.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*UTC/);
  if (!m?.[1]) return null;
  const iso = `${m[1].replace(" ", "T")}:00Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return { ts_utc: new Date(ms).toISOString(), ms };
}

export function parseAlertText(raw: string): ParsedAlert {
  const errors: string[] = [];
  const text = String(raw || "");

  // --- symbol ---
  // Prefer explicit patterns:
  // - "[告警｜T3] ETHUSDT DISTRIBUTION"
  // - "⚠️ [HIGH] USDCUSDT｜1m"
  // - "📈 USDCUSDT"
  let symbol: string | null = null;
  let event_type: string | null = null;
  let direction: "up" | "down" | "flat" | null = null;
  let window: string | null = null;
  let tier: string | null = null;
  let ts_utc: string | null = null;

  const header = text.match(/\[告警[^\]]*\]\s*([A-Z0-9_]{3,30})\s+([A-Z_]{3,40})/);
  if (header?.[1]) symbol = header[1].toUpperCase();
  if (header?.[2]) event_type = normalizeEventType(header[2]);

  let m = text.match(/📈\s*([A-Z0-9_]{3,30})\b/);
  if (!symbol && m?.[1]) symbol = m[1].toUpperCase();

  if (!symbol) {
    const m2 = text.match(/\b([A-Z0-9]{3,20}(USDT|USDC|FDUSD|BTC|ETH))\b/);
    if (m2?.[1]) symbol = m2[1].toUpperCase();
  }

  if (!symbol) errors.push("symbol_not_found");

  // --- priority ---
  let priority: ParsedAlert["priority"] = null;
  const pm = text.match(/\[(LOW|MEDIUM|HIGH|CRITICAL)\]/i);
  if (pm?.[1]) priority = pm[1].toUpperCase() as ParsedAlert["priority"];

  // --- tier (T1/T2/T3) ---
  const tm1 = text.match(/告警[|｜]T(\d)/i);
  if (tm1?.[1]) tier = `T${tm1[1]}`;
  const tm2 = text.match(/Tier\s*(T?\d)/i);
  if (!tier && tm2?.[1]) tier = tm2[1].startsWith("T") ? tm2[1].toUpperCase() : `T${tm2[1]}`;

  // --- window ---
  const wm1 = text.match(/[|｜]\s*(\d{1,3}m)\b/);
  if (wm1?.[1]) window = wm1[1];
  const wm2 = text.match(/窗口[:：]\s*(\d{1,3}m)/i);
  if (!window && wm2?.[1]) window = wm2[1];

  // --- event_type / direction ---
  const tdm = text.match(/类型\/方向[:：]\s*([A-Z_]{3,40})\s*\/\s*([A-Za-z]+|上行|下行|横盘)/);
  if (tdm?.[1]) event_type = normalizeEventType(tdm[1]) || event_type;
  if (tdm?.[2]) direction = normalizeDirection(tdm[2]) || direction;

  const dm = text.match(/[（(][^）)]*(上行|下行|横盘|flat|up|down)/i);
  if (!direction && dm?.[1]) direction = normalizeDirection(dm[1]);

  // --- factor ---
  let factor: number | null = null;
  const fm1 = text.match(/volume_factor\s*=\s*([0-9.]+)x/i);
  const fm2 = text.match(/强度[:：][^\n]*?([0-9.]+)x/i);
  const fm3 = text.match(/成交量\s*([0-9.]+)x/i);
  const fm4 = text.match(/factor[:=]\s*([0-9.]+)/i);
  const fsrc = fm1?.[1] || fm2?.[1] || fm3?.[1] || fm4?.[1];
  if (fsrc) {
    factor = numOrNull(fsrc);
    if (factor === null) errors.push("factor_nan");
  }

  // --- change_pct ---
  let change_pct: number | null = null;
  // change_pct 表示价格变化；告警格式会输出 "价 <pct>"，不要把价差/溢价当作 change_pct。
  const cm1 = text.match(/price_change\s*=\s*([+\-0-9.]+)%/i);
  const cm2 = text.match(/价格[:：]\s*([+\-0-9.]+)%/i);
  const cm3 = text.match(/(?:^|[；;\s])价\s*([+\-0-9.]+)%/i);
  const cm4 = text.match(/change_pct[:=]\s*([+\-0-9.]+)%/i);
  const csrc = cm1?.[1] || cm2?.[1] || cm3?.[1] || cm4?.[1];
  if (csrc) {
    change_pct = numOrNull(csrc);
    if (change_pct === null) errors.push("change_pct_nan");
  }

  // --- lookback ---
  let lookback: number | null = null;
  const lm = text.match(/lookback[:=]\s*([0-9]+)/i);
  if (lm?.[1]) {
    lookback = numOrNull(lm[1]);
    if (lookback === null) errors.push("lookback_nan");
  }

  // --- candle ---
  let candle: ParsedAlert["candle"] = null;
  const cam = text.match(/candle[:=]\s*(closed|open)/i);
  if (cam?.[1]) candle = cam[1].toLowerCase() as ParsedAlert["candle"];

  // --- anchor_ms ---
  let anchor_ms: number | null = null;
  const am = text.match(/candle_open_time_ms[:=]\s*([0-9,]+)/i);
  if (am?.[1]) {
    anchor_ms = parseMsLike(am[1]);
    if (anchor_ms === null) errors.push("candle_open_time_ms_nan");
  }
  if (anchor_ms === null) {
    const ts = parseUtcMinute(text);
    if (ts) {
      anchor_ms = ts.ms;
      ts_utc = ts.ts_utc;
    }
  }

  const ok = !!symbol;

  return {
    ok,
    errors,
    symbol,
    anchor_ms,
    priority,
    factor,
    change_pct,
    lookback,
    candle,
    event_type,
    direction,
    window,
    tier,
    ts_utc,
  };
}
