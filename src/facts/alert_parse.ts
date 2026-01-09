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
};

function numOrNull(x: any): number | null {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

function parseMsLike(s: string): number | null {
  const cleaned = s.replace(/,/g, "").trim();
  return numOrNull(cleaned);
}

export function parseAlertText(raw: string): ParsedAlert {
  const errors: string[] = [];
  const text = String(raw || "");

  // --- symbol ---
  // Prefer explicit patterns:
  // - "[HIGH] 📈 USDCUSDT"
  // - "📈 USDCUSDT"
  // - line "- symbol: BTCUSDT" (future)
  let symbol: string | null = null;

  let m = text.match(/📈\s*([A-Z0-9_]{3,30})\b/);
  if (m?.[1]) symbol = m[1].toUpperCase();

  if (!symbol) {
    const m2 = text.match(/\b([A-Z0-9]{3,20}(USDT|USDC|FDUSD|BTC|ETH))\b/);
    if (m2?.[1]) symbol = m2[1].toUpperCase();
  }

  if (!symbol) errors.push("symbol_not_found");

  // --- priority ---
  let priority: ParsedAlert["priority"] = null;
  const pm = text.match(/\[(LOW|MEDIUM|HIGH|CRITICAL)\]/i);
  if (pm?.[1]) priority = pm[1].toUpperCase() as ParsedAlert["priority"];

  // --- factor ---
  let factor: number | null = null;
  const fm = text.match(/factor:\s*([0-9.]+)/i);
  if (fm?.[1]) {
    factor = numOrNull(fm[1]);
    if (factor === null) errors.push("factor_nan");
  }

  // --- change_pct ---
  let change_pct: number | null = null;
  const cm = text.match(/change_pct:\s*([0-9.\-]+)%/i);
  if (cm?.[1]) {
    change_pct = numOrNull(cm[1]);
    if (change_pct === null) errors.push("change_pct_nan");
  }

  // --- lookback ---
  let lookback: number | null = null;
  const lm = text.match(/lookback:\s*([0-9]+)/i);
  if (lm?.[1]) {
    lookback = numOrNull(lm[1]);
    if (lookback === null) errors.push("lookback_nan");
  }

  // --- candle ---
  let candle: ParsedAlert["candle"] = null;
  const cam = text.match(/candle:\s*(closed|open)/i);
  if (cam?.[1]) candle = cam[1].toLowerCase() as ParsedAlert["candle"];

  // --- anchor_ms ---
  let anchor_ms: number | null = null;
  const am = text.match(/candle_open_time_ms:\s*([0-9,]+)/i);
  if (am?.[1]) {
    anchor_ms = parseMsLike(am[1]);
    if (anchor_ms === null) errors.push("candle_open_time_ms_nan");
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
  };
}
