import path from "node:path";

export type SeedanceCommand = {
  prompt: string;
  imageUrl?: string;
  durationSec?: number;
};

export type SeedanceTaskSnapshot = {
  taskId: string;
  status: string;
  videoUrl?: string;
  mime?: string;
  filename?: string;
  error?: string;
};

export type SeedanceTaskResult = {
  ok: true;
  snapshot: SeedanceTaskSnapshot;
} | {
  ok: false;
  error: string;
  statusCode?: number;
};

type JsonCallResult = {
  ok: true;
  statusCode: number;
  data: any;
} | {
  ok: false;
  statusCode?: number;
  error: string;
};

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com";
const DEFAULT_CREATE_PATH = "/api/v3/contents/generations/tasks";
const DEFAULT_QUERY_PATH_PREFIX = "/api/v3/contents/generations/tasks";
const DEFAULT_TIMEOUT_MS = 30_000;

function trimToString(raw: unknown): string {
  return String(raw ?? "").trim();
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseObjectEnv(name: string): Record<string, unknown> {
  const raw = trimToString(process.env[name]);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeBaseUrl(raw: unknown): string {
  const value = trimToString(raw) || DEFAULT_BASE_URL;
  return value.replace(/\/+$/, "");
}

function normalizePath(raw: unknown, fallback: string): string {
  const value = trimToString(raw) || fallback;
  if (!value.startsWith("/")) return `/${value}`;
  return value;
}

function buildUrl(base: string, p: string): string {
  return `${normalizeBaseUrl(base)}${normalizePath(p, "/")}`;
}

function withTimeoutSignal(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

async function callJson(
  method: "POST" | "GET",
  url: string,
  apiKey: string,
  body?: any,
): Promise<JsonCallResult> {
  const timeoutMs = clampInt(process.env.SEEDANCE_HTTP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 120_000);
  const { signal, cancel } = withTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      const detail = trimToString((data as any)?.error?.message)
        || trimToString((data as any)?.error)
        || trimToString((data as any)?.message)
        || trimToString(text).slice(0, 280)
        || `http_${res.status}`;
      return { ok: false, statusCode: res.status, error: detail };
    }
    return { ok: true, statusCode: res.status, data };
  } catch (e: any) {
    const name = trimToString(e?.name);
    if (name === "AbortError") return { ok: false, error: "seedance_timeout" };
    return { ok: false, error: trimToString(e?.message || e) || "seedance_fetch_failed" };
  } finally {
    cancel();
  }
}

function readPath(data: any, p: string): unknown {
  const parts = p.split(".");
  let current: any = data;
  for (const key of parts) {
    if (current == null) return undefined;
    if (/^\d+$/.test(key)) {
      const idx = Number(key);
      if (!Array.isArray(current) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function firstString(data: any, paths: string[]): string {
  for (const p of paths) {
    const value = trimToString(readPath(data, p));
    if (value) return value;
  }
  return "";
}

function normalizeStatus(rawStatus: string, hasVideo: boolean, hasError: boolean): string {
  const status = trimToString(rawStatus).toLowerCase();
  if (hasVideo) return "completed";
  if (!status) return hasError ? "failed" : "accepted";
  if (status === "succeeded" || status === "success" || status === "completed" || status === "done") {
    return "completed";
  }
  if (
    status === "failed"
    || status === "error"
    || status === "cancelled"
    || status === "canceled"
    || status === "rejected"
  ) {
    return "failed";
  }
  if (
    status === "accepted"
    || status === "queued"
    || status === "in_progress"
    || status === "processing"
    || status === "running"
    || status === "pending"
  ) {
    return "in_progress";
  }
  return status;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(trimToString(value));
}

function scoreUrlPath(pathLabel: string): number {
  const p = pathLabel.toLowerCase();
  if (p.includes("image")) return -1;
  if (p.includes("video_url")) return 100;
  if (p.includes("video")) return 80;
  if (p.includes("download_url")) return 60;
  if (p.includes("download")) return 50;
  if (p.includes("url")) return 20;
  return 0;
}

function extractVideoUrl(raw: any): string {
  const direct = firstString(raw, [
    "video_url",
    "videoUrl",
    "output.video_url",
    "output.videoUrl",
    "result.video_url",
    "result.videoUrl",
    "data.video_url",
    "data.videoUrl",
    "data.output.video_url",
    "data.output.videoUrl",
    "data.result.video_url",
    "data.result.videoUrl",
    "data.outputs.0.video_url",
    "data.outputs.0.videoUrl",
  ]);
  if (looksLikeUrl(direct)) return direct;

  let bestUrl = "";
  let bestScore = -1;
  const walk = (node: any, pathParts: string[]) => {
    if (node == null) return;
    if (typeof node === "string") {
      const candidate = trimToString(node);
      if (!looksLikeUrl(candidate)) return;
      const label = pathParts.join(".");
      const score = scoreUrlPath(label);
      if (score > bestScore) {
        bestScore = score;
        bestUrl = candidate;
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, [...pathParts, String(idx)]));
      return;
    }
    if (typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        walk(value, [...pathParts, key]);
      }
    }
  };
  walk(raw, []);
  return bestScore >= 0 ? bestUrl : "";
}

function detectMime(videoUrl: string): string {
  const raw = trimToString(videoUrl);
  if (!raw) return "video/mp4";
  try {
    const parsed = new URL(raw);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (ext === ".webm") return "video/webm";
    if (ext === ".mov") return "video/quicktime";
    if (ext === ".mkv") return "video/x-matroska";
    if (ext === ".mp4") return "video/mp4";
  } catch {
    // ignore malformed URL and fall back.
  }
  return "video/mp4";
}

function detectFilename(videoUrl: string): string {
  const raw = trimToString(videoUrl);
  if (!raw) return "seedance-video.mp4";
  try {
    const parsed = new URL(raw);
    const name = path.basename(parsed.pathname || "");
    if (name && name !== "/" && name !== ".") return name;
  } catch {
    // fall through
  }
  return "seedance-video.mp4";
}

function resolveTaskId(raw: any, fallbackTaskId?: string): string {
  const id = firstString(raw, [
    "task_id",
    "taskId",
    "id",
    "request_id",
    "data.task_id",
    "data.taskId",
    "data.id",
    "data.request_id",
    "task.task_id",
    "task.id",
    "result.task_id",
    "result.id",
  ]);
  if (id) return id;
  return trimToString(fallbackTaskId);
}

function extractError(raw: any): string {
  return firstString(raw, [
    "error.message",
    "error",
    "message",
    "detail",
    "data.error.message",
    "data.error",
    "data.message",
  ]);
}

function toSnapshot(raw: any, fallbackTaskId?: string): SeedanceTaskSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const taskId = resolveTaskId(raw, fallbackTaskId);
  if (!taskId) return null;
  const videoUrl = extractVideoUrl(raw);
  const error = extractError(raw);
  const rawStatus = firstString(raw, [
    "status",
    "state",
    "data.status",
    "data.state",
    "task.status",
    "task.state",
    "result.status",
    "result.state",
  ]);
  const status = normalizeStatus(rawStatus, Boolean(videoUrl), Boolean(error));
  return {
    taskId,
    status,
    videoUrl: videoUrl || undefined,
    mime: videoUrl ? detectMime(videoUrl) : undefined,
    filename: videoUrl ? detectFilename(videoUrl) : undefined,
    error: error || undefined,
  };
}

function resolveApiKey(): string {
  return trimToString(process.env.SEEDANCE_API_KEY || process.env.ARK_API_KEY || process.env.VOLCENGINE_API_KEY);
}

function resolveModel(): string {
  return trimToString(process.env.SEEDANCE_MODEL || "doubao-seedance-1-0-pro-250528");
}

function resolveCreateUrl(): string {
  const baseUrl = normalizeBaseUrl(process.env.SEEDANCE_API_BASE_URL || process.env.ARK_API_BASE_URL || DEFAULT_BASE_URL);
  const p = normalizePath(process.env.SEEDANCE_CREATE_PATH, DEFAULT_CREATE_PATH);
  return buildUrl(baseUrl, p);
}

function resolveQueryUrl(taskId: string): string {
  const baseUrl = normalizeBaseUrl(process.env.SEEDANCE_API_BASE_URL || process.env.ARK_API_BASE_URL || DEFAULT_BASE_URL);
  const prefixRaw = normalizePath(process.env.SEEDANCE_QUERY_PATH_PREFIX, DEFAULT_QUERY_PATH_PREFIX);
  if (prefixRaw.includes("{id}")) {
    return buildUrl(baseUrl, prefixRaw.replace(/\{id\}/g, encodeURIComponent(taskId)));
  }
  return buildUrl(baseUrl, `${prefixRaw.replace(/\/+$/, "")}/${encodeURIComponent(taskId)}`);
}

function buildCreatePayload(input: SeedanceCommand): Record<string, unknown> {
  const content: any[] = [{ type: "text", text: input.prompt }];
  if (input.imageUrl) {
    content.push({
      type: "image_url",
      image_url: { url: input.imageUrl },
    });
  }
  const defaults = parseObjectEnv("SEEDANCE_DEFAULT_PROPERTIES_JSON");
  const properties: Record<string, unknown> = { ...defaults };
  if (input.durationSec && properties.duration == null) {
    properties.duration = input.durationSec;
  }
  const body: Record<string, unknown> = {
    model: resolveModel(),
    content,
  };
  if (Object.keys(properties).length) {
    body.properties = properties;
  }
  return body;
}

export function isSeedanceEnabled(): boolean {
  return Boolean(resolveApiKey());
}

export function isSeedanceTerminalStatus(status: string): boolean {
  const value = trimToString(status).toLowerCase();
  return value === "completed" || value === "failed";
}

export function parseSeedanceCommand(rawText: string): SeedanceCommand | null {
  const raw = trimToString(rawText);
  const matched = raw.match(/^\/video(?:@[A-Za-z0-9_]+)?(?:\s+|$)([\s\S]*)$/i);
  if (!matched) return null;
  let rest = trimToString(matched[1]);
  if (!rest) return { prompt: "" };

  let imageUrl = "";
  let durationSec: number | undefined;

  rest = rest.replace(/--image(?:=|\s+)(\S+)/gi, (_full, value) => {
    const candidate = trimToString(value);
    if (looksLikeUrl(candidate)) imageUrl = candidate;
    return " ";
  });

  rest = rest.replace(/--duration(?:=|\s+)(\d+)/gi, (_full, value) => {
    durationSec = clampInt(value, 5, 1, 30);
    return " ";
  });

  const prompt = rest.replace(/\s+/g, " ").trim();
  return {
    prompt,
    imageUrl: imageUrl || undefined,
    durationSec,
  };
}

export async function createSeedanceTask(input: SeedanceCommand): Promise<SeedanceTaskResult> {
  const apiKey = resolveApiKey();
  if (!apiKey) return { ok: false, error: "missing_seedance_api_key" };
  const prompt = trimToString(input.prompt);
  if (!prompt) return { ok: false, error: "missing_prompt" };
  const createUrl = resolveCreateUrl();
  const payload = buildCreatePayload({ ...input, prompt });
  const result = await callJson("POST", createUrl, apiKey, payload);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error || "seedance_create_failed",
      statusCode: result.statusCode,
    };
  }
  const snapshot = toSnapshot(result.data);
  if (!snapshot) {
    return { ok: false, error: "seedance_missing_task_id", statusCode: result.statusCode };
  }
  return { ok: true, snapshot };
}

export async function querySeedanceTask(taskId: string): Promise<SeedanceTaskResult> {
  const normalizedTaskId = trimToString(taskId);
  if (!normalizedTaskId) return { ok: false, error: "missing_task_id" };
  const apiKey = resolveApiKey();
  if (!apiKey) return { ok: false, error: "missing_seedance_api_key" };
  const queryUrl = resolveQueryUrl(normalizedTaskId);
  const result = await callJson("GET", queryUrl, apiKey);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error || "seedance_query_failed",
      statusCode: result.statusCode,
    };
  }
  const snapshot = toSnapshot(result.data, normalizedTaskId);
  if (!snapshot) {
    return { ok: false, error: "seedance_invalid_status_payload", statusCode: result.statusCode };
  }
  return { ok: true, snapshot };
}
