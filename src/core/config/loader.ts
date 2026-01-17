import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { PolicyConfig, ProjectManifest } from "./types.js";

export function loadPolicy(policyPath: string): {
  ok: boolean;
  data?: PolicyConfig;
  error?: string;
} {
  try {
    if (!fs.existsSync(policyPath)) {
      return { ok: false, error: `policy_not_found:${policyPath}` };
    }
    const raw = fs.readFileSync(policyPath, "utf-8");
    const data = YAML.parse(raw) as PolicyConfig;
    return { ok: true, data };
  } catch (e: any) {
    return { ok: false, error: `policy_load_failed:${String(e?.message || e)}` };
  }
}

export function loadProjects(dirPath: string): {
  ok: boolean;
  data: Record<string, ProjectManifest>;
  errors: string[];
} {
  const out: Record<string, ProjectManifest> = {};
  const errors: string[] = [];

  try {
    if (!fs.existsSync(dirPath)) {
      errors.push(`projects_dir_missing:${dirPath}`);
      return { ok: false, data: out, errors };
    }

    const files = fs
      .readdirSync(dirPath)
      .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));

    for (const f of files) {
      const full = path.join(dirPath, f);
      try {
        const raw = fs.readFileSync(full, "utf-8");
        const obj = YAML.parse(raw) as ProjectManifest;
        if (!obj?.project_id) {
          errors.push(`project_missing_id:${f}`);
          continue;
        }
        out[obj.project_id] = obj;
      } catch (e: any) {
        errors.push(`project_load_failed:${f}:${String(e?.message || e)}`);
      }
    }
  } catch (e: any) {
    errors.push(`projects_load_failed:${String(e?.message || e)}`);
    return { ok: false, data: out, errors };
  }

  return { ok: errors.length === 0, data: out, errors };
}
