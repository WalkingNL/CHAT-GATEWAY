export type DispatchStatus = "done" | "clarify" | "rejected" | "failed";

export type ResultRef = {
  type: "image_path" | "text" | "error_code";
  value: string;
  expires_at?: string;
};

export type ResultRefMeta = {
  result_ref: ResultRef;
  result_ref_version: "v1";
  result_ref_ttl_sec?: number;
  result_ref_expires_at?: string;
};

const RESULT_REF_VERSION = "v1" as const;
const DEFAULT_RESULT_TTL_SEC = 86400;
const MAX_RESULT_TTL_SEC = 604800;

function parseResultTtlSec(): number {
  const raw = String(process.env.ON_DEMAND_RESULT_TTL_SEC || "").trim();
  if (!raw) return DEFAULT_RESULT_TTL_SEC;
  const val = Number(raw);
  if (!Number.isFinite(val)) return DEFAULT_RESULT_TTL_SEC;
  const clamped = Math.min(Math.max(val, 0), MAX_RESULT_TTL_SEC);
  return clamped;
}

const RESULT_TTL_SEC = parseResultTtlSec();

function calcExpiresAt(ttlSec: number): string | undefined {
  if (ttlSec <= 0) return undefined;
  return new Date(Date.now() + ttlSec * 1000).toISOString();
}

export function buildImageResultRef(imagePath: string): ResultRefMeta {
  const ttlSec = RESULT_TTL_SEC;
  const expiresAt = calcExpiresAt(ttlSec);
  const resultRef: ResultRef = {
    type: "image_path",
    value: imagePath,
    expires_at: expiresAt,
  };
  return {
    result_ref: resultRef,
    result_ref_version: RESULT_REF_VERSION,
    result_ref_ttl_sec: ttlSec || undefined,
    result_ref_expires_at: expiresAt,
  };
}

export function buildTextResultRef(text: string): ResultRefMeta {
  const resultRef: ResultRef = {
    type: "text",
    value: text,
  };
  return {
    result_ref: resultRef,
    result_ref_version: RESULT_REF_VERSION,
  };
}

export function normalizeErrorCode(raw: string): string {
  let val = String(raw || "").trim();
  if (!val) return "";
  if (val.includes(":")) {
    const parts = val.split(":");
    val = parts[parts.length - 1].trim();
  }
  return val;
}

export function buildErrorResultRef(errorCode: string): ResultRefMeta {
  const normalized = normalizeErrorCode(errorCode) || "unknown_error";
  const resultRef: ResultRef = {
    type: "error_code",
    value: normalized,
  };
  return {
    result_ref: resultRef,
    result_ref_version: RESULT_REF_VERSION,
  };
}

export function mapOnDemandStatus(params: {
  status?: string | null;
  error?: string | null;
  undetermined?: boolean | null;
}): DispatchStatus {
  const status = String(params.status || "").toLowerCase();
  let error = normalizeErrorCode(params.error || "").toLowerCase();
  const undetermined = Boolean(params.undetermined);

  if (error) {
    if (undetermined || error.startsWith("missing_")) return "clarify";
    if (error.startsWith("invalid_") || error === "panel_id_not_allowed") return "rejected";
    if (error === "missing_project_id") return "failed";
    return "failed";
  }

  if (status === "failed") return "failed";
  if (status === "accepted" || status === "in_progress" || status === "done") return "done";
  return "failed";
}
