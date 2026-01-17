import type { ExplainInput, ExplainPath } from "../path_types.js";

export const volumePriceDivergence: ExplainPath = {
  id: "volume_price_divergence",
  priority: 60,
  match: (input: ExplainInput) => {
    const factor = input.parsed?.factor;
    const cp = input.parsed?.change_pct;
    if (typeof factor !== "number" || typeof cp !== "number") return false;
    return factor >= 2 && Math.abs(cp) <= 0.5;
  },
  promptAddon: () =>
    "Path: Volume/price divergence. Emphasize large volume factor with muted price change; look for churn, absorption, or liquidity-driven activity.",
};
