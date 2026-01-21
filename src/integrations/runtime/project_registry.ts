import fs from "node:fs";

import { loadConfig } from "../../core/config/loadConfig.js";

export type ProjectRegistry = {
  projects?: Record<string, {
    on_demand?: {
      url?: string;
      token?: string;
      token_env?: string;
      window_spec_id?: string;
    };
    on_demand_url?: string;
    on_demand_token?: string;
    on_demand_token_env?: string;
    on_demand_window_spec_id?: string;
    notify?: {
      telegram_chat_ids?: Array<string | number>;
      feishu_chat_ids?: Array<string | number>;
      overrides?: any;
      target_overrides?: any;
    };
    notify_overrides?: any;
  }>;
};

function toStrList(val: any): string[] {
  if (Array.isArray(val)) return val.map(v => String(v)).filter(Boolean);
  if (val == null) return [];
  return [String(val)];
}

export type RegistryLoadResult = {
  ok: boolean;
  data: ProjectRegistry;
  error?: string;
};

export function tryLoadProjectRegistry(
  path = String(process.env.PROJECTS_REGISTRY_PATH || "config/projects.yml"),
): RegistryLoadResult {
  try {
    if (!fs.existsSync(path)) return { ok: true, data: { projects: {} } };
    const raw = loadConfig(path) as ProjectRegistry;
    return { ok: true, data: raw || { projects: {} } };
  } catch (e: any) {
    return { ok: false, data: { projects: {} }, error: String(e?.message || e) };
  }
}

export function loadProjectRegistry(path = String(process.env.PROJECTS_REGISTRY_PATH || "config/projects.yml")): ProjectRegistry {
  const res = tryLoadProjectRegistry(path);
  if (!res.ok) {
    console.warn("[registry][WARN] load failed:", res.error || "unknown");
  }
  return res.data;
}

export function resolveProjectNotifyTargets(registry: ProjectRegistry, projectId: string | undefined | null) {
  if (!projectId) return { telegram: [], feishu: [] };
  const proj = registry.projects?.[projectId];
  const notify = proj?.notify ?? {};
  return {
    telegram: toStrList(notify.telegram_chat_ids),
    feishu: toStrList(notify.feishu_chat_ids),
  };
}
