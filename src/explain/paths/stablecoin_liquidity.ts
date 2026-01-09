import type { ExplainInput, ExplainPath } from "../path_types.js";

const STABLES = new Set(["USDCUSDT", "USDTUSDC", "FDUSDUSDT", "USDPUSDT", "TUSDUSDT"]);

export const stablecoinLiquidity: ExplainPath = {
  id: "stablecoin_liquidity",
  priority: 90,
  match: (input: ExplainInput) => {
    const sym = String(input.parsed?.symbol || "").toUpperCase();
    if (!sym || !STABLES.has(sym)) return false;
    const cp = input.parsed?.change_pct;
    if (typeof cp !== "number") return false;
    return Math.abs(cp) <= 0.15;
  },
  promptAddon: () =>
    "Path: Stablecoin liquidity context. Focus on near-zero price change with volume spikes, potential liquidity routing or peg stability events.",
};
