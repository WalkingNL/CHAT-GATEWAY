import type { ExplainInput, ExplainPath } from "./path_types.js";

const registry: ExplainPath[] = [];

export function registerPath(path: ExplainPath) {
  if (!path || !path.id) return;
  if (registry.find((p) => p.id === path.id)) return;
  registry.push({ ...path, enabled: path.enabled !== false });
}

export function listPaths(): ExplainPath[] {
  return [...registry];
}

export function pickPaths(input: ExplainInput, k = 2): ExplainPath[] {
  const enabled = registry.filter((p) => p.enabled !== false);
  const matches = enabled.filter((p) => {
    try {
      return p.match(input);
    } catch {
      return false;
    }
  });
  matches.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.id.localeCompare(b.id);
  });
  return matches.slice(0, Math.max(0, k));
}
