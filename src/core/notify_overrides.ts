import type { ProjectRegistry } from "../integrations/runtime/project_registry.js";

export type TargetOverride = {
  min_priority?: string;
  source?: string;
};

export type TargetOverrides = {
  telegram: Record<string, TargetOverride>;
  feishu: Record<string, TargetOverride>;
};

const PRIORITY_LEVELS = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

function warnInvalid(source: string, reason: string, detail: Record<string, string>) {
  const parts = Object.entries(detail)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`);
  const suffix = parts.length ? ` (${parts.join(", ")})` : "";
  console.warn(`[notify_overrides][WARN] ${source} ${reason}${suffix}`);
}

function normalizePriority(val: any): string | null {
  const s = String(val || "").trim().toUpperCase();
  if (!s) return null;
  return PRIORITY_LEVELS.has(s) ? s : null;
}

function normalizeTarget(val: any): "telegram" | "feishu" | null {
  const s = String(val || "").trim().toLowerCase();
  if (s === "telegram" || s === "tg") return "telegram";
  if (s === "feishu" || s === "fs") return "feishu";
  return null;
}

function emptyOverrides(): TargetOverrides {
  return { telegram: {}, feishu: {} };
}

function addOverride(
  out: TargetOverrides,
  target: "telegram" | "feishu",
  chatId: string,
  minPriority: string | null,
  source: string,
) {
  const id = String(chatId || "").trim();
  if (!id) return;
  if (!minPriority) {
    warnInvalid(source, "invalid_min_priority", { target, chat_id: id });
    return;
  }
  out[target][id] = { min_priority: minPriority, source };
}

function parseOverrideList(raw: any, source: string): TargetOverrides {
  const out = emptyOverrides();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const targetRaw = (item as any).target ?? (item as any).channel ?? (item as any).provider;
    const target = normalizeTarget(targetRaw);
    const chatId = (item as any).chat_id ?? (item as any).chatId ?? (item as any).chat;
    const minPriority = normalizePriority((item as any).min_priority ?? (item as any).minPriority ?? (item as any).priority);
    if (!chatId) continue;
    if (!target) {
      warnInvalid(source, "invalid_target", { target: String(targetRaw || ""), chat_id: String(chatId) });
      continue;
    }
    addOverride(out, target, String(chatId), minPriority, source);
  }
  return out;
}

function parseOverrideMap(raw: any, source: string): TargetOverrides {
  const out = emptyOverrides();
  if (!raw || typeof raw !== "object") return out;
  for (const targetKey of ["telegram", "feishu"]) {
    const target = normalizeTarget(targetKey);
    if (!target) continue;
    const map = (raw as any)[targetKey];
    if (!map || typeof map !== "object") continue;
    for (const [chatId, cfg] of Object.entries(map)) {
      const minPriority = normalizePriority((cfg as any)?.min_priority ?? cfg);
      if (!minPriority) {
        warnInvalid(source, "invalid_min_priority", { target, chat_id: String(chatId) });
        continue;
      }
      addOverride(out, target, String(chatId), minPriority, source);
    }
  }
  return out;
}

function mergeOverrides(base: TargetOverrides, extra: TargetOverrides): TargetOverrides {
  const merged: TargetOverrides = {
    telegram: { ...base.telegram },
    feishu: { ...base.feishu },
  };
  for (const [id, cfg] of Object.entries(extra.telegram)) merged.telegram[id] = cfg;
  for (const [id, cfg] of Object.entries(extra.feishu)) merged.feishu[id] = cfg;
  return merged;
}

export function resolveTargetOverrides(registry: ProjectRegistry, projectId?: string | null): TargetOverrides {
  if (!projectId) return emptyOverrides();
  const proj = registry.projects?.[projectId];
  if (!proj) return emptyOverrides();

  let merged = emptyOverrides();
  const rawOverrides = (proj as any).notify_overrides;
  if (Array.isArray(rawOverrides)) {
    merged = mergeOverrides(merged, parseOverrideList(rawOverrides, "notify_overrides"));
  } else if (rawOverrides && typeof rawOverrides === "object") {
    merged = mergeOverrides(merged, parseOverrideMap(rawOverrides, "notify_overrides"));
  }

  const notify = (proj as any).notify || {};
  const rawNotifyOverrides = notify.overrides ?? notify.target_overrides;
  if (Array.isArray(rawNotifyOverrides)) {
    merged = mergeOverrides(merged, parseOverrideList(rawNotifyOverrides, "notify.overrides"));
  } else if (rawNotifyOverrides && typeof rawNotifyOverrides === "object") {
    merged = mergeOverrides(merged, parseOverrideMap(rawNotifyOverrides, "notify.overrides"));
  }

  return merged;
}
