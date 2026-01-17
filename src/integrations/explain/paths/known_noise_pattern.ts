import type { ExplainInput, ExplainPath } from "../path_types.js";

export const knownNoisePattern: ExplainPath = {
  id: "known_noise_pattern",
  priority: 1,
  match: (_input: ExplainInput) => {
    return false;
  },
  promptAddon: () =>
    "Path: Known noise pattern. If alert matches known benign patterns, keep interpretation conservative.",
};
