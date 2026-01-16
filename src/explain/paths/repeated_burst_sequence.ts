import type { ExplainInput, ExplainPath } from "../path_types.js";

export const repeatedBurstSequence: ExplainPath = {
  id: "repeated_burst_sequence",
  priority: 80,
  match: (input: ExplainInput) => {
    const items = input.facts?.symbol_recent?.items;
    if (!Array.isArray(items)) return false;
    return items.length >= 3;
  },
  promptAddon: () =>
    "Path: Repeated burst sequence. Highlight multiple recent alerts for the same symbol and consider persistence or clustering.",
};
