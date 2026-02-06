type HttpError = {
  code: string;
  status?: number;
  detail?: string;
  raw?: string;
};

type JsonResult =
  | { ok: true; status: number; data: any; text: string }
  | { ok: false; error: HttpError };

type RetryOptions = {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
  retryOnStatuses: number[];
};

type PostOptions = {
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  retryJitterMs?: number;
  retryOnStatuses?: number[];
};

function parseIntEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const val = Number(raw);
  if (!Number.isFinite(val)) return fallback;
  return Math.max(0, Math.floor(val));
}

function resolveRetryOptions(opts?: PostOptions): RetryOptions {
  return {
    retries: opts?.retries ?? parseIntEnv("CHAT_GATEWAY_HTTP_RETRIES", 0),
    baseDelayMs: opts?.retryBaseMs ?? parseIntEnv("CHAT_GATEWAY_HTTP_RETRY_BASE_MS", 200),
    maxDelayMs: opts?.retryMaxMs ?? parseIntEnv("CHAT_GATEWAY_HTTP_RETRY_MAX_MS", 2000),
    jitterMs: opts?.retryJitterMs ?? parseIntEnv("CHAT_GATEWAY_HTTP_RETRY_JITTER_MS", 100),
    retryOnStatuses: opts?.retryOnStatuses ?? [408, 429, 500, 502, 503, 504],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFetchError(err: any): HttpError {
  const name = String(err?.name || "");
  if (name === "AbortError") return { code: "timeout" };
  const message = String(err?.message || err || "");
  return { code: "fetch_failed", detail: message || undefined };
}

function shouldRetry(err: HttpError, opts: RetryOptions): boolean {
  if (err.code === "timeout" || err.code === "fetch_failed") return true;
  if (err.code.startsWith("http_")) {
    const status = err.status ?? Number(err.code.replace("http_", ""));
    if (Number.isFinite(status) && opts.retryOnStatuses.includes(status)) return true;
  }
  return false;
}

function computeBackoff(attempt: number, opts: RetryOptions): number {
  const base = opts.baseDelayMs * Math.pow(2, Math.max(0, attempt));
  const capped = Math.min(base, opts.maxDelayMs);
  const jitter = opts.jitterMs > 0 ? Math.floor(Math.random() * opts.jitterMs) : 0;
  return capped + jitter;
}

async function postJsonOnce(url: string, token: string, body: any, timeoutMs?: number): Promise<JsonResult> {
  const controller = new AbortController();
  const timeout = Math.max(1, timeoutMs ?? parseIntEnv("CHAT_GATEWAY_HTTP_TIMEOUT_MS", 8000));
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
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = null;
    }
    if (!res.ok) {
      const detail = (data && typeof data === "object" && data.error) ? String(data.error) : undefined;
      return {
        ok: false,
        error: {
          code: `http_${res.status}`,
          status: res.status,
          detail: detail || (text ? text.slice(0, 400) : undefined),
          raw: text,
        },
      };
    }
    if (data == null) {
      return { ok: false, error: { code: "invalid_json", status: res.status, raw: text } };
    }
    return { ok: true, status: res.status, data, text };
  } catch (e: any) {
    return { ok: false, error: normalizeFetchError(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function postJson(url: string, token: string, body: any, opts?: PostOptions): Promise<JsonResult> {
  const retry = resolveRetryOptions(opts);
  const timeoutMs = opts?.timeoutMs;
  let attempt = 0;
  let lastError: HttpError | null = null;
  while (attempt <= retry.retries) {
    const res = await postJsonOnce(url, token, body, timeoutMs);
    if (res.ok) return res;
    lastError = res.error;
    if (attempt >= retry.retries || !shouldRetry(res.error, retry)) {
      return res;
    }
    const delayMs = computeBackoff(attempt, retry);
    await sleep(delayMs);
    attempt += 1;
  }
  return { ok: false, error: lastError || { code: "unknown" } };
}

export async function postJsonWithAuth(
  url: string,
  token: string,
  body: any,
  opts?: PostOptions,
): Promise<any> {
  const res = await postJson(url, token, body, opts);
  if (res.ok) return res.data;
  const err = res.error;
  if (err.code === "invalid_json") {
    return { ok: false, error: "invalid_json", raw: err.raw };
  }
  if (err.code.startsWith("http_")) {
    const detail = err.detail ? `: ${err.detail}` : "";
    throw new Error(`on_demand_${err.code}${detail}`);
  }
  if (err.code === "timeout") throw new Error("timeout");
  if (err.code === "fetch_failed") throw new Error(`fetch_failed${err.detail ? `: ${err.detail}` : ""}`);
  throw new Error(err.code || "unknown");
}
