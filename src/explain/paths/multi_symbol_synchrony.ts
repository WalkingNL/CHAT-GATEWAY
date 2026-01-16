import type { ExplainInput, ExplainPath } from "../path_types.js";

export const multiSymbolSynchrony: ExplainPath = {
  id: "multi_symbol_synchrony",
  priority: 70,
  match: (input: ExplainInput) => {
    const w1h = input.facts?.window_1h;
    if (!w1h || !w1h.ok) return false;
    const count = Number(w1h.symbol_count || 0);
    return count >= 3;
  },
  promptAddon: () =>
    "Path: Multi-symbol synchrony. Note concurrent activity across multiple symbols in the same window and consider market-wide drivers.",
};
