export type ParsedAlert = {
  ok: boolean;
  symbol?: string;
  priority?: string;
  factor?: number;
  change_pct?: number;
  candle_open_time_ms?: number;
  errors?: string[];
};

export function parseAlertText(alertRaw: string): ParsedAlert {
  const errors: string[] = [];
  const raw = String(alertRaw || "");

  const symMatch =
    raw.match(/\b([A-Z0-9]{5,20}USDT|USDCUSDT|USDTUSDC|FDUSDUSDT)\b/) || null;

  const symbol = symMatch ? symMatch[1] : undefined;
  if (!symbol) errors.push("symbol_not_found");

  const prMatch = raw.match(/\[(LOW|MEDIUM|HIGH|CRITICAL)\]/i);
  const priority = prMatch ? prMatch[1].toUpperCase() : undefined;

  const factorMatch = raw.match(/factor:\s*([0-9.]+)/i);
  const factor = factorMatch ? Number(factorMatch[1]) : undefined;
  if (factorMatch && !Number.isFinite(factor!)) errors.push("factor_nan");

  const cpMatch = raw.match(/change_pct:\s*([0-9.\-]+)%/i);
  const change_pct = cpMatch ? Number(cpMatch[1]) : undefined;
  if (cpMatch && !Number.isFinite(change_pct!)) errors.push("change_pct_nan");

  const cotMatch = raw.match(/candle_open_time_ms:\s*([0-9,]+)/i);
  const candle_open_time_ms = cotMatch
    ? Number(String(cotMatch[1]).replace(/,/g, ""))
    : undefined;

  if (cotMatch && !Number.isFinite(candle_open_time_ms!)) errors.push("candle_open_time_ms_nan");

  return {
    ok: errors.length === 0 || !!symbol,
    symbol,
    priority,
    factor,
    change_pct,
    candle_open_time_ms,
    errors: errors.length ? errors : undefined,
  };
}
