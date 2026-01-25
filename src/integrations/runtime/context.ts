import fs from "node:fs";

import { loadConfig } from "../../core/config/loadConfig.js";
import { loadAllConfig } from "../../core/config/index.js";
import type { LoadedConfig } from "../../core/config/types.js";
import { RateLimiter } from "../../core/rateLimit/limiter.js";
import { listPaths } from "../explain/path_registry.js";
import { registerDefaultPaths } from "../explain/paths/index.js";
import { checkErrorCodesVersion, loadAuditPolicyOnce, startAuditPolicyWatcher } from "./audit_policy.js";
import { loadCapabilitiesOnce, startCapabilitiesWatcher } from "./capabilities.js";

export type IntegrationContext = {
  cfg: any;
  loaded: LoadedConfig;
  storageDir: string;
  limiter: RateLimiter;
};

export function buildIntegrationContext(configPath = "config.yaml"): IntegrationContext {
  loadCapabilitiesOnce();
  startCapabilitiesWatcher();
  loadAuditPolicyOnce();
  startAuditPolicyWatcher();
  const requiredErrorCodesVersion = String(process.env.ERROR_CODES_VERSION_REQUIRED || "").trim();
  if (requiredErrorCodesVersion && !checkErrorCodesVersion(requiredErrorCodesVersion)) {
    console.error(
      "[audit][ERROR] error_codes_version mismatch",
      "required=" + requiredErrorCodesVersion,
    );
    const strict = String(process.env.ERROR_CODES_STRICT || "").trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(strict)) {
      throw new Error("error_codes_version mismatch");
    }
  }

  const cfg = loadConfig(configPath);
  const loaded = loadAllConfig();
  registerDefaultPaths();
  console.log("[explain] paths", listPaths().map(p => p.id));
  console.log("[config]", {
    policyOk: loaded.meta.policyOk,
    projectsCount: loaded.meta.projectsCount,
    project_ids: Object.keys(loaded.projects),
  });
  if (loaded.meta.errors.length) {
    console.warn("[config][WARN]", loaded.meta.errors.join("; "));
  }

  const storageDir = cfg.gateway?.storage?.dir ?? "./data";
  fs.mkdirSync(storageDir, { recursive: true });

  const perUser = Number(cfg.gateway?.rate_limit?.per_user_per_min ?? 10);
  const global = Number(cfg.gateway?.rate_limit?.global_per_min ?? 30);
  const limiter = new RateLimiter(perUser, global);

  return { cfg, loaded, storageDir, limiter };
}
