import { loadProjectRegistry } from "./project_registry.js";
import { EXPORT_API_VERSION } from "./intent_schema.js";

type OnDemandSettings = {
  url?: string;
  token?: string;
  windowSpecId?: string;
};

type OnDemandConfig = {
  url: string;
  token: string;
  windowSpecId?: string;
};

type DashboardExportResult = {
  ok: boolean;
  status?: string;
  traceId?: string;
  error?: string;
  imagePath?: string;
  undetermined?: boolean;
  filtersDropped?: string[];
};

type IntentResolveResult = {
  ok: boolean;
  intent?: string;
  params?: Record<string, any>;
  confidence?: number;
  needClarify?: boolean;
  reason?: string;
  unknownReason?: string;
  schemaVersion?: string;
  intentVersion?: string;
  error?: string;
  traceId?: string;
};

function resolveOnDemandSettings(projectId?: string | null): OnDemandSettings {
  const envUrl = String(process.env.CRYPTO_AGENT_ON_DEMAND_URL || "").trim();
  const envToken = String(process.env.CRYPTO_AGENT_ON_DEMAND_TOKEN || "").trim();
  const envWindowSpecId = String(
    process.env.CHAT_GATEWAY_WINDOW_SPEC_ID
      || process.env.CRYPTO_AGENT_WINDOW_SPEC_ID
      || "",
  ).trim();
  const useEnvAuth = Boolean(envUrl && envToken);
  const registry = loadProjectRegistry();
  const proj = projectId ? registry.projects?.[projectId] : undefined;
  const anyProj = proj ?? registry.projects?.crypto_agent ?? null;
  const onDemand = (anyProj as any)?.on_demand ?? {};

  const url = String(
    (useEnvAuth ? envUrl : "")
      || onDemand.url
      || (anyProj as any)?.on_demand_url
      || envUrl
      || "http://127.0.0.1:8799",
  ).trim();

  const tokenEnv = String(
    onDemand.token_env
      || (anyProj as any)?.on_demand_token_env
      || "",
  ).trim();
  const token = String(
    (useEnvAuth ? envToken : "")
      || (tokenEnv ? process.env[tokenEnv] : "")
      || onDemand.token
      || (anyProj as any)?.on_demand_token
      || envToken
      || "",
  ).trim();

  const windowSpecId = String(
    onDemand.window_spec_id
      || (anyProj as any)?.on_demand_window_spec_id
      || envWindowSpecId
      || "",
  ).trim();

  return {
    url: url || undefined,
    token: token || undefined,
    windowSpecId: windowSpecId || undefined,
  };
}

function resolveOnDemandConfig(projectId?: string | null): OnDemandConfig {
  const settings = resolveOnDemandSettings(projectId);
  if (!settings.url) throw new Error("missing_on_demand_url");
  if (!settings.token) throw new Error("missing_on_demand_token");
  return {
    url: settings.url,
    token: settings.token,
    windowSpecId: settings.windowSpecId,
  };
}

export function resolveDefaultWindowSpecId(projectId?: string | null): string | null {
  const settings = resolveOnDemandSettings(projectId);
  return settings.windowSpecId || null;
}

export function sanitizeRequestId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 200);
}

const FILTER_ALLOWED_KEYS = new Set(["symbol", "window_minutes", "window_hours", "date_utc", "date"]);

function sanitizeFilters(raw: Record<string, any> | undefined): { filters: Record<string, any>; dropped: string[] } {
  if (!raw || typeof raw !== "object") return { filters: {}, dropped: [] };
  const out: Record<string, any> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!FILTER_ALLOWED_KEYS.has(key)) {
      dropped.push(key);
      continue;
    }
    let val = value;
    if (val == null) continue;
    if (typeof val === "string") {
      val = val.trim();
      if (!val) continue;
    }
    out[key] = val;
  }
  if (dropped.length) dropped.sort();
  return { filters: out, dropped };
}

async function postJson(url: string, token: string, body: any, timeoutMs?: number): Promise<any> {
  const timeout = Number(
    timeoutMs
      ?? process.env.CHAT_GATEWAY_EXPORT_ACK_TIMEOUT_MS
      ?? process.env.CHAT_GATEWAY_CHART_ACK_TIMEOUT_MS
      ?? "2000",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { ok: false, error: "invalid_json", raw: text };
    }
    if (!res.ok) {
      throw new Error(`on_demand_http_${res.status}: ${data?.error || text}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestDashboardExport(params: {
  projectId: string;
  requestId: string;
  panelId: string;
  windowSpecId?: string | null;
  filters: Record<string, any>;
  exportApiVersion?: string;
  schemaVersion?: string;
  intentVersion?: string;
  target: { channel: "telegram" | "feishu"; chatId: string };
}): Promise<DashboardExportResult> {
  const sanitized = sanitizeFilters(params.filters);
  const filtersDropped = sanitized.dropped.length ? sanitized.dropped : undefined;
  try {
    const cfg = resolveOnDemandConfig(params.projectId);
    const payload: any = {
      request_id: params.requestId,
      panel_id: params.panelId,
      filters: sanitized.filters,
      export_api_version: params.exportApiVersion || EXPORT_API_VERSION,
      target: {
        project_id: params.projectId,
        target: params.target.channel,
        chat_id: params.target.chatId,
      },
    };
    if (params.windowSpecId) payload.window_spec_id = params.windowSpecId;
    if (params.schemaVersion) payload.schema_version = params.schemaVersion;
    if (params.intentVersion) payload.intent_version = params.intentVersion;
    const res = await postJson(`${cfg.url}/v1/dashboard_export`, cfg.token, payload);
    return {
      ok: Boolean(res?.ok),
      status: res?.status ? String(res.status) : undefined,
      traceId: res?.trace_id ? String(res.trace_id) : undefined,
      error: res?.error ? String(res.error) : undefined,
      imagePath: res?.image_path ? String(res.image_path) : undefined,
      undetermined: Boolean(res?.undetermined),
      filtersDropped,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e), filtersDropped };
  }
}

export async function requestIntentResolve(params: {
  projectId: string;
  requestId: string;
  rawQuery: string;
  channel: string;
  chatId: string;
  userId: string;
}): Promise<IntentResolveResult> {
  try {
    const cfg = resolveOnDemandConfig(params.projectId);
    const timeoutMs = Number(process.env.CHAT_GATEWAY_INTENT_RESOLVE_TIMEOUT_MS || "8000");
    const payload = {
      request_id: params.requestId,
      raw_query: params.rawQuery,
      channel: params.channel,
      chat_id: params.chatId,
      user_id: params.userId,
    };
    const res = await postJson(`${cfg.url}/v1/intent/resolve`, cfg.token, payload, timeoutMs);
    return {
      ok: Boolean(res?.ok),
      intent: res?.intent ? String(res.intent) : undefined,
      params: res?.params && typeof res.params === "object" ? res.params : undefined,
      confidence: typeof res?.confidence === "number" ? res.confidence : undefined,
      needClarify: Boolean(res?.need_clarify),
      reason: res?.reason ? String(res.reason) : undefined,
      unknownReason: res?.unknown_reason ? String(res.unknown_reason) : undefined,
      schemaVersion: res?.schema_version ? String(res.schema_version) : undefined,
      intentVersion: res?.intent_version ? String(res.intent_version) : undefined,
      traceId: res?.trace_id ? String(res.trace_id) : undefined,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
