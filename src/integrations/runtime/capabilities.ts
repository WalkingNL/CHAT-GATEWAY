import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

type IntentConfig = {
  enabled?: boolean;
  panel_id_allowlist?: string[];
};

export type CapabilitiesSnapshot = {
  version: string;
  retry_policy_version: string;
  config_hash: string;
  intents: Record<string, IntentConfig>;
  loaded_at: string;
};

const DEFAULT_SNAPSHOT: CapabilitiesSnapshot = {
  version: "missing",
  retry_policy_version: "missing",
  config_hash: "",
  intents: {},
  loaded_at: new Date(0).toISOString(),
};

let snapshot: CapabilitiesSnapshot = DEFAULT_SNAPSHOT;
let watcherStarted = false;

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalizeIntentConfig(raw: any): IntentConfig {
  const out: IntentConfig = {};
  if (raw && typeof raw === "object") {
    if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
    if (Array.isArray(raw.panel_id_allowlist)) {
      out.panel_id_allowlist = raw.panel_id_allowlist.map(String).filter(Boolean);
    }
  }
  return out;
}

function parseCapabilities(raw: string): CapabilitiesSnapshot {
  const data = YAML.parse(raw);
  if (!data || typeof data !== "object") throw new Error("capabilities_invalid_root");

  const version = String((data as any).version || "").trim();
  if (!version) throw new Error("capabilities_missing_version");

  const retryPolicyVersion = String((data as any).retry_policy_version || version).trim() || version;
  const intentsRaw = (data as any).intents;
  if (!intentsRaw || typeof intentsRaw !== "object") throw new Error("capabilities_missing_intents");

  const intents: Record<string, IntentConfig> = {};
  for (const [key, value] of Object.entries(intentsRaw)) {
    intents[String(key)] = normalizeIntentConfig(value);
  }

  return {
    version,
    retry_policy_version: retryPolicyVersion,
    config_hash: hashText(raw),
    intents,
    loaded_at: new Date().toISOString(),
  };
}

function resolveCapabilitiesPath(): string {
  const override = String(process.env.CAPABILITIES_PATH || "").trim();
  if (override) return override;
  return path.join("config", "capabilities.yml");
}

function loadCapabilitiesInternal(): void {
  const filePath = resolveCapabilitiesPath();
  const raw = readText(filePath);
  if (raw == null) {
    console.warn("[capabilities][WARN] missing file", filePath);
    return;
  }

  try {
    const next = parseCapabilities(raw);
    if (next.config_hash === snapshot.config_hash) return;
    snapshot = next;
    console.log("[capabilities] loaded", {
      version: snapshot.version,
      retry_policy_version: snapshot.retry_policy_version,
      config_hash: snapshot.config_hash,
    });
  } catch (e: any) {
    console.error("[capabilities][WARN] load failed:", String(e?.message || e));
  }
}

export function loadCapabilitiesOnce(): void {
  if (snapshot === DEFAULT_SNAPSHOT) {
    loadCapabilitiesInternal();
  }
}

export function startCapabilitiesWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  const intervalSec = Math.max(5, Number(process.env.CAPABILITIES_REFRESH_SEC || "30"));
  setInterval(loadCapabilitiesInternal, intervalSec * 1000).unref();
}

export function getCapabilitiesSnapshot(): CapabilitiesSnapshot {
  return snapshot;
}

export function isIntentEnabled(intent: string): boolean {
  const cfg = snapshot.intents[intent];
  if (!cfg) return true;
  return cfg.enabled !== false;
}

export function getCapabilityAuditMeta(): {
  capability_config_version: string;
  retry_policy_version: string;
  capability_config_hash: string;
} {
  return {
    capability_config_version: snapshot.version,
    retry_policy_version: snapshot.retry_policy_version,
    capability_config_hash: snapshot.config_hash,
  };
}
