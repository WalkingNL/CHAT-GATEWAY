import type { ExplainInput, ExplainPath } from "../path_types.js";

export const baselineExtremePosition: ExplainPath = {
  id: "baseline_extreme_position",
  priority: 10,
  match: (_input: ExplainInput) => {
    return false;
  },
  promptAddon: () =>
    "Path: Baseline extreme position. If baseline context exists, compare current activity to historical extremes.",
};
