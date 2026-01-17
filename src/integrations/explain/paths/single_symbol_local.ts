import type { ExplainInput, ExplainPath } from "../path_types.js";

export const singleSymbolLocal: ExplainPath = {
  id: "single_symbol_local",
  priority: 50,
  match: (input: ExplainInput) => {
    const sym = input.parsed?.symbol;
    const w1h = input.facts?.window_1h;
    if (!sym || !w1h || !w1h.ok) return false;
    const count = Number(w1h.symbol_count || 0);
    return count <= 1;
  },
  promptAddon: () =>
    "Path: Single-symbol local event. Focus on symbol-specific context rather than market-wide drivers.",
};
