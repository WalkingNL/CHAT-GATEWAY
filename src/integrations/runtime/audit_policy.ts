import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

type ErrorCodesConfig = {
  version: string;
  codes: string[];
};

type RedactionPolicy = {
  version: string;
  enabled: boolean;
  keep_head_chars: number;
  hash_algo: string;
  fields: string[];
};

const DEFAULT_ERROR_CODES: ErrorCodesConfig = { version: "missing", codes: [] };
const DEFAULT_REDACTION: RedactionPolicy = {
  version: "missing",
  enabled: false,
  keep_head_chars: 0,
  hash_algo: "sha256",
  fields: [],
};

let errorCodes = DEFAULT_ERROR_CODES;
let redactionPolicy = DEFAULT_REDACTION;
let watcherStarted = false;

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function parseErrorCodes(raw: string): ErrorCodesConfig {
  const data = YAML.parse(raw);
  if (!data || typeof data !== "object") throw new Error("error_codes_invalid_root");
  const version = String((data as any).version || "").trim();
  if (!version) throw new Error("error_codes_missing_version");
  const codes = Array.isArray((data as any).codes) ? (data as any).codes.map(String).filter(Boolean) : [];
  return { version, codes };
}

function parseRedactionPolicy(raw: string): RedactionPolicy {
  const data = YAML.parse(raw);
  if (!data || typeof data !== "object") throw new Error("redaction_invalid_root");
  const version = String((data as any).version || "").trim();
  if (!version) throw new Error("redaction_missing_version");
  const enabled = Boolean((data as any).enabled);
  const keepHead = Math.max(0, Number((data as any).keep_head_chars || 0));
  const hashAlgo = String((data as any).hash_algo || "sha256").trim() || "sha256";
  const fields = Array.isArray((data as any).fields) ? (data as any).fields.map(String).filter(Boolean) : [];
  return {
    version,
    enabled,
    keep_head_chars: keepHead,
    hash_algo: hashAlgo,
    fields,
  };
}

function resolveErrorCodesPath(): string {
  const override = String(process.env.ERROR_CODES_PATH || "").trim();
  if (override) return override;
  return path.join("config", "error_codes.yaml");
}

function resolveRedactionPath(): string {
  const override = String(process.env.REDACTION_POLICY_PATH || "").trim();
  if (override) return override;
  return path.join("config", "redaction_policy.yaml");
}

function loadErrorCodes(): void {
  const filePath = resolveErrorCodesPath();
  const raw = readText(filePath);
  if (raw == null) {
    console.warn("[audit][WARN] missing error_codes", filePath);
    return;
  }
  try {
    errorCodes = parseErrorCodes(raw);
    console.log("[audit] error_codes loaded", { version: errorCodes.version, count: errorCodes.codes.length });
  } catch (e: any) {
    console.error("[audit][WARN] error_codes load failed:", String(e?.message || e));
  }
}

function loadRedactionPolicy(): void {
  const filePath = resolveRedactionPath();
  const raw = readText(filePath);
  if (raw == null) {
    console.warn("[audit][WARN] missing redaction_policy", filePath);
    return;
  }
  try {
    redactionPolicy = parseRedactionPolicy(raw);
    console.log("[audit] redaction_policy loaded", {
      version: redactionPolicy.version,
      enabled: redactionPolicy.enabled,
      fields: redactionPolicy.fields.length,
    });
  } catch (e: any) {
    console.error("[audit][WARN] redaction_policy load failed:", String(e?.message || e));
  }
}

export function loadAuditPolicyOnce(): void {
  if (errorCodes === DEFAULT_ERROR_CODES) loadErrorCodes();
  if (redactionPolicy === DEFAULT_REDACTION) loadRedactionPolicy();
}

export function startAuditPolicyWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  const intervalSec = Math.max(10, Number(process.env.AUDIT_POLICY_REFRESH_SEC || "60"));
  setInterval(() => {
    loadErrorCodes();
    loadRedactionPolicy();
  }, intervalSec * 1000).unref();
}

export function getAuditMeta(): { error_codes_version: string; redaction_policy_version: string } {
  return {
    error_codes_version: errorCodes.version,
    redaction_policy_version: redactionPolicy.version,
  };
}

export function checkErrorCodesVersion(expected: string): boolean {
  if (!expected) return true;
  return errorCodes.version === expected;
}

function hashText(value: string, algo: string): string {
  const safeAlgo = algo || "sha256";
  try {
    return crypto.createHash(safeAlgo).update(value).digest("hex");
  } catch {
    return crypto.createHash("sha256").update(value).digest("hex");
  }
}

export function applyRedaction(entry: any): { entry: any; applied: boolean } {
  if (!redactionPolicy.enabled || !redactionPolicy.fields.length) {
    return { entry, applied: false };
  }
  const out = { ...entry };
  let applied = false;

  for (const field of redactionPolicy.fields) {
    const val = out[field];
    if (typeof val !== "string" || !val) continue;
    out[`${field}_sha256`] = hashText(val, redactionPolicy.hash_algo);
    const head = redactionPolicy.keep_head_chars > 0
      ? val.slice(0, redactionPolicy.keep_head_chars)
      : "";
    out[field] = head;
    applied = true;
  }

  return { entry: out, applied };
}
