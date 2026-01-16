import type { ExplainInput, ExplainPath } from "../path_types.js";

export const systemHealthSuspect: ExplainPath = {
  id: "system_health_suspect",
  priority: 5,
  match: (_input: ExplainInput) => {
    return false;
  },
  promptAddon: () =>
    "Path: System health suspect. If facts show collection errors or gaps, note possible data integrity issues.",
};
