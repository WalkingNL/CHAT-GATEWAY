import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { handleAdapterIntentIfAny } from "../router/router.js";
import { resolveProjectId } from "../router/intent_handlers.js";
import { requestIntentResolve, sanitizeRequestId } from "./intent_router.js";
import type { AdapterResultProbe } from "./handlers.js";
import type { LoadedConfig } from "../../core/config/types.js";

type InboundChannel = "telegram" | "feishu";

type StoredInboundArtifact = {
  id: string;
  type: "image_path";
  file_path: string;
  mime?: string;
  filename?: string;
  size_bytes?: number;
  expires_at?: string;
  intent?: string;
  request_id?: string;
};

type InboundArtifact = {
  id: string;
  type: "image_path";
  value: string;
  preview_url: string;
  download_url: string;
  mime?: string;
  filename?: string;
  size_bytes?: number;
  expires_at?: string;
  intent?: string;
  request_id?: string;
};

type InboundRequestState = {
  intent: string;
  request_id: string;
  status?: string;
  error?: string;
};

type InboundRecordStored = {
  ok: boolean;
  request_id: string;
  status: "completed" | "clarify" | "error";
  intent?: string;
  confidence?: number;
  need_clarify?: boolean;
  reply_text?: string;
  error?: string;
  unknown_reason?: string;
  reason?: string;
  artifacts?: StoredInboundArtifact[];
  requests?: InboundRequestState[];
  meta?: {
    latency_ms?: number;
    channel?: InboundChannel;
    chat_type?: "private" | "group";
    adapter_entry?: boolean;
  };
  ts_utc: string;
};

type InboundRecord = Omit<InboundRecordStored, "artifacts"> & {
  artifacts?: InboundArtifact[];
};

type InboundAccepted = {
  ok: true;
  request_id: string;
  status: "accepted";
  ts_utc: string;
};

export type PublicInboundResult = InboundRecord | InboundAccepted;
type StoredInboundResult = InboundRecordStored | InboundAccepted;

type PublicInboundMessageInput = {
  request_id?: unknown;
  channel?: unknown;
  chat_type?: unknown;
  chat_id?: unknown;
  user_id?: unknown;
  message_id?: unknown;
  reply_to_id?: unknown;
  text?: unknown;
  reply_text?: unknown;
  mentions_bot?: unknown;
  wait_ms?: unknown;
};

type RuntimeOpts = {
  cfg: any;
  loaded: LoadedConfig;
  storageDir: string;
};

type RuntimePost = {
  ok: true;
  response: PublicInboundResult;
} | {
  ok: false;
  statusCode: number;
  error: string;
};

type RuntimeGet = {
  ok: true;
  response: PublicInboundResult;
} | {
  ok: false;
  statusCode: number;
  error: string;
};

const INBOUND_INTENT_ALLOWLIST = new Set([
  "alert_explain",
  "news_summary",
  "news_hot",
  "news_refresh",
  "dashboard_export",
  "chart_factor_timeline",
  "chart_daily_activity",
  "data_feeds_status",
  "data_feeds_asset_status",
  "data_feeds_source_status",
  "data_feeds_hotspots",
  "data_feeds_ops_summary",
  "alert_level_query",
  "alert_level_set",
]);

const ACK_PATTERNS = [
  /^🧠\s*正在/i,
  /^🧠\s*我看一下/i,
];

const ARTIFACT_POLL_INTERVAL_MS = clampInt(
  process.env.CHAT_GATEWAY_PUBLIC_ARTIFACT_POLL_INTERVAL_MS,
  1200,
  200,
  10_000,
);
const PUBLIC_ARTIFACT_TTL_SEC = clampInt(
  process.env.CHAT_GATEWAY_PUBLIC_ARTIFACT_TTL_SEC || process.env.ON_DEMAND_RESULT_TTL_SEC,
  86_400,
  0,
  604_800,
);
const PUBLIC_BASE_URL = String(process.env.CHAT_GATEWAY_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");

const inflight = new Map<string, Promise<InboundRecordStored>>();

function nowIso(): string {
  return new Date().toISOString();
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function trimToString(raw: unknown): string {
  return String(raw ?? "").trim();
}

function sanitizeId(raw: string): string {
  return String(raw || "")
    .replace(/[^A-Za-z0-9._:-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function hashString(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function detectMime(filePath: string): string {
  const lower = path.extname(String(filePath || "")).toLowerCase();
  if (lower === ".png") return "image/png";
  if (lower === ".jpg" || lower === ".jpeg") return "image/jpeg";
  if (lower === ".webp") return "image/webp";
  if (lower === ".gif") return "image/gif";
  return "application/octet-stream";
}

function resolveSizeBytes(filePath: string): number | undefined {
  try {
    const stat = fs.statSync(filePath);
    return Number.isFinite(stat.size) ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

function calcExpiresAt(): string | undefined {
  if (PUBLIC_ARTIFACT_TTL_SEC <= 0) return undefined;
  return new Date(Date.now() + PUBLIC_ARTIFACT_TTL_SEC * 1000).toISOString();
}

function buildArtifactPath(requestId: string, artifactId: string, mode: "preview" | "download"): string {
  const encodedRequestId = encodeURIComponent(requestId);
  const encodedArtifactId = encodeURIComponent(artifactId);
  return `/v1/inbound/artifacts/${encodedRequestId}/${encodedArtifactId}/${mode}`;
}

function withPublicBase(p: string): string {
  if (!PUBLIC_BASE_URL) return p;
  return `${PUBLIC_BASE_URL}${p}`;
}

function toStoredArtifact(signal: AdapterResultProbe): StoredInboundArtifact | null {
  const filePath = trimToString(signal.imagePath);
  const requestId = sanitizeRequestId(trimToString(signal.requestId));
  if (!filePath || !requestId) return null;
  const id = `art_${hashString(`${requestId}:${filePath}`).slice(0, 16)}`;
  return {
    id,
    type: "image_path",
    file_path: filePath,
    mime: detectMime(filePath),
    filename: path.basename(filePath),
    size_bytes: resolveSizeBytes(filePath),
    expires_at: calcExpiresAt(),
    intent: signal.intent,
    request_id: requestId,
  };
}

function normalizeStoredArtifact(raw: any, fallbackRequestId: string): StoredInboundArtifact | null {
  if (!raw || typeof raw !== "object") return null;
  const filePath = trimToString(raw.file_path) || trimToString(raw.value);
  const type = trimToString(raw.type);
  if (!filePath || type !== "image_path") return null;
  const requestId = sanitizeRequestId(trimToString(raw.request_id) || fallbackRequestId);
  const id = sanitizeId(trimToString(raw.id) || `art_${hashString(`${requestId}:${filePath}`).slice(0, 16)}`);
  return {
    id,
    type: "image_path",
    file_path: filePath,
    mime: trimToString(raw.mime) || detectMime(filePath),
    filename: trimToString(raw.filename) || path.basename(filePath),
    size_bytes: Number.isFinite(Number(raw.size_bytes)) ? Number(raw.size_bytes) : resolveSizeBytes(filePath),
    expires_at: trimToString(raw.expires_at) || calcExpiresAt(),
    intent: trimToString(raw.intent) || undefined,
    request_id: requestId,
  };
}

function toPublicArtifact(requestId: string, artifact: StoredInboundArtifact): InboundArtifact {
  const effectiveRequestId = sanitizeRequestId(trimToString(artifact.request_id) || requestId);
  const previewPath = buildArtifactPath(effectiveRequestId, artifact.id, "preview");
  const downloadPath = buildArtifactPath(effectiveRequestId, artifact.id, "download");
  return {
    id: artifact.id,
    type: "image_path",
    value: withPublicBase(downloadPath),
    preview_url: withPublicBase(previewPath),
    download_url: withPublicBase(downloadPath),
    mime: artifact.mime,
    filename: artifact.filename,
    size_bytes: artifact.size_bytes,
    expires_at: artifact.expires_at,
    intent: artifact.intent,
    request_id: effectiveRequestId,
  };
}

function normalizeStoredResult(raw: any): StoredInboundResult | null {
  if (!raw || typeof raw !== "object") return null;
  if (trimToString(raw.status) === "accepted") {
    const requestId = sanitizeRequestId(trimToString(raw.request_id));
    if (!requestId) return null;
    return {
      ok: true,
      request_id: requestId,
      status: "accepted",
      ts_utc: trimToString(raw.ts_utc) || nowIso(),
    };
  }
  const requestId = sanitizeRequestId(trimToString(raw.request_id));
  if (!requestId) return null;
  const rawArtifacts: any[] = Array.isArray(raw.artifacts) ? raw.artifacts : [];
  const artifacts = rawArtifacts
    .map((artifact: any) => normalizeStoredArtifact(artifact, requestId))
    .filter((artifact: StoredInboundArtifact | null): artifact is StoredInboundArtifact => Boolean(artifact));
  const statusRaw = trimToString(raw.status).toLowerCase();
  const status = statusRaw === "clarify" || statusRaw === "error" ? statusRaw : "completed";
  return {
    ...(raw as InboundRecordStored),
    request_id: requestId,
    status,
    artifacts: artifacts.length ? artifacts : undefined,
    ts_utc: trimToString(raw.ts_utc) || nowIso(),
  };
}

function toPublicResult(stored: StoredInboundResult): PublicInboundResult {
  if (stored.status === "accepted") return stored;
  const artifacts = Array.isArray(stored.artifacts)
    ? stored.artifacts.map((artifact) => toPublicArtifact(stored.request_id, artifact))
    : [];
  return {
    ...stored,
    artifacts: artifacts.length ? artifacts : undefined,
  };
}

function deriveIdentity(token: string, clientIdRaw?: string): { chatId: string; userId: string } {
  const normalizedClientId = sanitizeId(trimToString(clientIdRaw));
  if (normalizedClientId) {
    return {
      chatId: `ext:${normalizedClientId}`,
      userId: `svc:${normalizedClientId}`,
    };
  }
  const tokenHash = hashString(token).slice(0, 16);
  return {
    chatId: `ext:token:${tokenHash}`,
    userId: `svc:token:${tokenHash}`,
  };
}

function resolveChannel(raw: unknown): InboundChannel {
  const channel = trimToString(raw).toLowerCase();
  if (channel === "feishu") return "feishu";
  return "telegram";
}

function resolveChatType(raw: unknown): "private" | "group" | null {
  const chatType = trimToString(raw).toLowerCase();
  if (!chatType) return "private";
  if (chatType === "private" || chatType === "group") return chatType;
  return null;
}

function resolveUnifiedPayload(text: string): string {
  const unified = text.match(/^\/i(?:@[A-Za-z0-9_]+)?(?:\s+|$)(.*)$/i);
  if (!unified) return text;
  return String(unified[1] || "").trim();
}

function pickReply(messages: string[]): string {
  const trimmed = messages.map(m => String(m || "").trim()).filter(Boolean);
  if (!trimmed.length) return "";
  const nonAck = trimmed.filter(text => !ACK_PATTERNS.some(re => re.test(text)));
  if (nonAck.length) return nonAck[nonAck.length - 1];
  return trimmed[trimmed.length - 1];
}

function collectArtifacts(signals: AdapterResultProbe[]): StoredInboundArtifact[] {
  const dedupe = new Set<string>();
  const artifacts: StoredInboundArtifact[] = [];
  for (const signal of signals) {
    const artifact = toStoredArtifact(signal);
    if (!artifact) continue;
    const imagePath = artifact.file_path;
    const key = `image_path:${imagePath}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    artifacts.push(artifact);
  }
  return artifacts;
}

function collectRequestStates(signals: AdapterResultProbe[]): InboundRequestState[] {
  const map = new Map<string, InboundRequestState>();
  for (const signal of signals) {
    const requestId = trimToString(signal.requestId);
    if (!requestId) continue;
    const key = `${signal.intent}:${requestId}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        intent: signal.intent,
        request_id: requestId,
        status: trimToString(signal.status) || undefined,
        error: trimToString(signal.error) || undefined,
      });
      continue;
    }
    const status = trimToString(signal.status);
    if (status) existing.status = status;
    const error = trimToString(signal.error);
    if (error) existing.error = error;
  }
  return Array.from(map.values());
}

function resolveArtifactWaitMs(waitMs: number): number {
  return clampInt(
    process.env.CHAT_GATEWAY_PUBLIC_ARTIFACT_WAIT_MS,
    Math.max(waitMs, 12_000),
    0,
    120_000,
  );
}

function shouldProbeSignal(signal: AdapterResultProbe): boolean {
  if (!signal.probe) return false;
  if (trimToString(signal.imagePath)) return false;
  const status = trimToString(signal.status).toLowerCase();
  const hasError = Boolean(trimToString(signal.error));
  if (!status) return !hasError;
  return (
    status === "accepted"
    || status === "in_progress"
    || status === "processing"
    || status === "queued"
    || status === "done"
  );
}

async function pollSignalsForArtifacts(signals: AdapterResultProbe[], waitMs: number): Promise<void> {
  if (!signals.length || waitMs <= 0) return;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const pending = signals.filter(shouldProbeSignal);
    if (!pending.length) return;

    await Promise.all(pending.map(async (signal) => {
      try {
        const next = await signal.probe!();
        const status = trimToString(next.status);
        if (status) signal.status = status;
        const imagePath = trimToString(next.imagePath);
        if (imagePath) signal.imagePath = imagePath;
        const error = trimToString(next.error);
        if (error) signal.error = error;
      } catch (e: any) {
        const error = trimToString(e?.message || e);
        if (error && !signal.error) signal.error = error;
      }
    }));

    if (collectArtifacts(signals).length) return;
    const remain = deadline - Date.now();
    if (remain <= 0) return;
    await sleep(Math.min(ARTIFACT_POLL_INTERVAL_MS, remain));
  }
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(filePath: string, data: any) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

class InboundStore {
  constructor(private storageDir: string) {}

  private baseDir() {
    return path.join(this.storageDir, "public_inbound");
  }

  private filePath(requestId: string) {
    return path.join(this.baseDir(), `${sanitizeRequestId(requestId)}.json`);
  }

  get(requestId: string): StoredInboundResult | null {
    const file = this.filePath(requestId);
    if (!fs.existsSync(file)) return null;
    try {
      return normalizeStoredResult(JSON.parse(fs.readFileSync(file, "utf-8")));
    } catch {
      return null;
    }
  }

  put(requestId: string, record: StoredInboundResult) {
    ensureDir(this.baseDir());
    atomicWriteJson(this.filePath(requestId), record);
  }
}

async function waitWithTimeout<T>(promise: Promise<T>, waitMs: number): Promise<{ done: true; value: T } | { done: false }> {
  if (waitMs <= 0) return { done: false };
  const result = await Promise.race([
    promise.then(value => ({ done: true as const, value })),
    new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), waitMs)),
  ]);
  return result;
}

function invalidRequest(error: string): RuntimePost {
  return { ok: false, statusCode: 400, error };
}

function resolveAuthContext(opts: RuntimeOpts, channel: InboundChannel) {
  const isTelegram = channel === "telegram";
  const allowlistMode = isTelegram
    ? (opts.cfg.channels?.telegram?.allowlist_mode || "auth")
    : (opts.cfg.channels?.feishu?.allowlist_mode || "auth");
  const ownerChatId = isTelegram
    ? String(opts.cfg.gateway?.owner?.telegram_chat_id || "")
    : String(opts.cfg.gateway?.owner?.feishu_chat_id || "");
  const ownerUserId = isTelegram
    ? String(process.env.OWNER_TELEGRAM_USER_ID || ownerChatId)
    : String(process.env.OWNER_FEISHU_USER_ID || ownerChatId);
  return {
    allowlistMode: allowlistMode === "owner_only" ? "owner_only" : "auth",
    ownerChatId,
    ownerUserId,
  } as const;
}

async function processInbound(opts: RuntimeOpts, body: Required<PublicInboundMessageInput>): Promise<InboundRecordStored> {
  const t0 = Date.now();
  const requestId = sanitizeRequestId(trimToString(body.request_id));
  const channel = resolveChannel(body.channel);
  const chatType = resolveChatType(body.chat_type) || "private";
  const chatId = trimToString(body.chat_id);
  const userId = trimToString(body.user_id);
  const messageId = trimToString(body.message_id) || requestId;
  const replyToId = trimToString(body.reply_to_id);
  const text = trimToString(body.text);
  const replyText = trimToString(body.reply_text);
  const mentionsBot = Boolean(body.mentions_bot);
  const isGroup = chatType === "group";

  const withMeta = <T extends Omit<InboundRecordStored, "request_id" | "ts_utc" | "meta">>(record: T): InboundRecordStored => ({
    ...record,
    request_id: requestId,
    ts_utc: nowIso(),
    meta: {
      latency_ms: Date.now() - t0,
      channel,
      chat_type: chatType,
      adapter_entry: true,
    },
  });

  if (isGroup && !/^\/i(?:@[A-Za-z0-9_]+)?(?:\s+|$)/i.test(text)) {
    return withMeta({
      ok: true,
      status: "clarify",
      intent: "unknown",
      need_clarify: true,
      confidence: 0,
      reason: "group_requires_unified_command",
      reply_text: "群聊请使用 /i + 自然语言（例如：/i 解释一下）。",
    });
  }

  const projectId = resolveProjectId(opts.loaded);
  if (!projectId) {
    return withMeta({
      ok: false,
      status: "error",
      error: "missing_project",
      reply_text: "未配置默认项目，无法解析请求。",
    });
  }

  const resolveText = resolveUnifiedPayload(text);
  if (!resolveText) {
    return withMeta({
      ok: true,
      status: "clarify",
      intent: "unknown",
      need_clarify: true,
      confidence: 0,
      reason: "empty_query",
      reply_text: "请提供自然语言请求内容。",
    });
  }

  let resolved: Awaited<ReturnType<typeof requestIntentResolve>>;
  try {
    resolved = await requestIntentResolve({
      projectId,
      requestId: sanitizeRequestId(`${requestId}:resolve`),
      rawQuery: resolveText,
      replyText,
      channel,
      chatId,
      userId,
    });
  } catch (e: any) {
    return withMeta({
      ok: false,
      status: "error",
      error: "resolve_failed",
      reason: String(e?.message || e),
      reply_text: "当前解析失败，请稍后重试。",
    });
  }

  const resolvedIntent = String(resolved.intent || "unknown");
  const confidence = Number.isFinite(Number(resolved.confidence)) ? Number(resolved.confidence) : 0;
  if (!resolved.ok || resolved.needClarify || resolvedIntent === "unknown") {
    return withMeta({
      ok: true,
      status: "clarify",
      intent: resolvedIntent,
      confidence,
      need_clarify: true,
      reason: String(resolved.reason || ""),
      unknown_reason: String(resolved.unknownReason || ""),
      reply_text: "我没有理解你的意图，请用一句话明确你要做的事。",
    });
  }

  if (!INBOUND_INTENT_ALLOWLIST.has(resolvedIntent)) {
    return withMeta({
      ok: true,
      status: "clarify",
      intent: resolvedIntent,
      confidence,
      need_clarify: true,
      reason: "intent_not_allowed",
      reply_text: "当前对外接口未开放该能力，请换一种请求。",
    });
  }

  const messages: string[] = [];
  const resultSignals: AdapterResultProbe[] = [];
  const send = async (_targetChatId: string, out: string) => {
    const value = String(out || "").trim();
    if (value) messages.push(value);
  };

  const authContext = resolveAuthContext(opts, channel);
  const handled = await handleAdapterIntentIfAny({
    storageDir: opts.storageDir,
    config: opts.loaded,
    allowlistMode: authContext.allowlistMode,
    ownerChatId: authContext.ownerChatId,
    ownerUserId: authContext.ownerUserId,
    channel,
    chatId,
    messageId,
    replyToId,
    userId,
    text,
    isGroup,
    mentionsBot,
    replyText,
    send,
    reportResult: (result) => {
      resultSignals.push(result);
    },
  });

  if (!handled) {
    return withMeta({
      ok: true,
      status: "clarify",
      intent: resolvedIntent,
      confidence,
      need_clarify: true,
      reason: "not_handled",
      reply_text: "请求未命中可执行流程，请换一种表达。",
    });
  }

  const reply = pickReply(messages);
  if (resultSignals.some(shouldProbeSignal)) {
    const artifactWaitMs = resolveArtifactWaitMs(clampInt(body.wait_ms, 8000, 0, 20_000));
    await pollSignalsForArtifacts(resultSignals, artifactWaitMs);
  }
  const artifacts = collectArtifacts(resultSignals);
  const requests = collectRequestStates(resultSignals);
  return withMeta({
    ok: true,
    status: "completed",
    intent: resolvedIntent,
    confidence,
    need_clarify: false,
    reply_text: reply || "(无输出)",
    artifacts: artifacts.length ? artifacts : undefined,
    requests: requests.length ? requests : undefined,
  });
}

export function createPublicInboundRuntime(opts: RuntimeOpts) {
  const token = String(process.env.CHAT_GATEWAY_PUBLIC_TOKEN || "").trim();
  const enabled = Boolean(token);
  const trustClientIdentity = String(process.env.CHAT_GATEWAY_PUBLIC_TRUST_CLIENT_IDENTITY || "").trim() === "1";
  const store = new InboundStore(opts.storageDir);

  async function postMessage(rawBody: any, idempotencyKey?: string, clientId?: string): Promise<RuntimePost> {
    if (!enabled) return { ok: false, statusCode: 403, error: "public_api_disabled" };
    const body = (rawBody || {}) as PublicInboundMessageInput;
    const requestIdRaw = trimToString(body.request_id) || trimToString(idempotencyKey);
    if (!requestIdRaw) return invalidRequest("missing_required_field:request_id");
    const requestId = sanitizeRequestId(requestIdRaw);
    const text = trimToString(body.text);
    const providedChatId = sanitizeId(trimToString(body.chat_id));
    const providedUserId = sanitizeId(trimToString(body.user_id));
    // In untrusted mode, caller identity is never used directly for auth checks.
    // We only treat caller fields as seed to derive namespaced external ids.
    const derivedSeed = trimToString(clientId) || providedChatId || providedUserId;
    const derived = deriveIdentity(token, derivedSeed || undefined);
    const chatId = trustClientIdentity
      ? (providedChatId || providedUserId || derived.chatId)
      : derived.chatId;
    const userId = trustClientIdentity
      ? (providedUserId || providedChatId || derived.userId)
      : derived.userId;
    const chatType = resolveChatType(body.chat_type);
    if (!chatType) return invalidRequest("unsupported_chat_type");
    if (!text) return invalidRequest("missing_required_field:text");
    const waitMs = clampInt(body.wait_ms, 8000, 0, 20000);

    const cached = store.get(requestId);
    if (cached && cached.status !== "accepted") {
      return { ok: true, response: toPublicResult(cached) };
    }

    let running = inflight.get(requestId);
    if (!running) {
      const normalized: Required<PublicInboundMessageInput> = {
        request_id: requestId,
        channel: body.channel || "external",
        chat_type: chatType,
        chat_id: chatId,
        user_id: userId,
        message_id: trimToString(body.message_id) || requestId,
        reply_to_id: trimToString(body.reply_to_id),
        text,
        reply_text: trimToString(body.reply_text),
        mentions_bot: Boolean(body.mentions_bot),
        wait_ms: waitMs,
      };
      running = processInbound(opts, normalized)
        .then((result) => {
          store.put(requestId, result);
          return result;
        })
        .catch((e: any) => {
          const failed: InboundRecordStored = {
            ok: false,
            request_id: requestId,
            status: "error",
            error: "internal_error",
            reason: String(e?.message || e),
            ts_utc: nowIso(),
          };
          store.put(requestId, failed);
          return failed;
        })
        .finally(() => {
          inflight.delete(requestId);
        });
      inflight.set(requestId, running);
    }

    const waitResult = await waitWithTimeout(running, waitMs);
    if (waitResult.done) {
      return { ok: true, response: toPublicResult(waitResult.value) };
    }

    const accepted: InboundAccepted = {
      ok: true,
      request_id: requestId,
      status: "accepted",
      ts_utc: nowIso(),
    };
    return { ok: true, response: accepted };
  }

  function getMessage(requestIdRaw: string): RuntimeGet {
    if (!enabled) return { ok: false, statusCode: 403, error: "public_api_disabled" };
    const requestId = sanitizeRequestId(trimToString(requestIdRaw));
    if (!requestId) return { ok: false, statusCode: 400, error: "missing_request_id" };
    const cached = store.get(requestId);
    if (cached) return { ok: true, response: toPublicResult(cached) };
    if (inflight.has(requestId)) {
      return {
        ok: true,
        response: {
          ok: true,
          request_id: requestId,
          status: "accepted",
          ts_utc: nowIso(),
        },
      };
    }
    return { ok: false, statusCode: 404, error: "not_found" };
  }

  function getArtifact(requestIdRaw: string, artifactIdRaw: string): {
    ok: true;
    artifact: {
      filePath: string;
      mime: string;
      filename: string;
      sizeBytes?: number;
    };
  } | {
    ok: false;
    statusCode: number;
    error: string;
  } {
    if (!enabled) return { ok: false, statusCode: 403, error: "public_api_disabled" };
    const requestId = sanitizeRequestId(trimToString(requestIdRaw));
    const artifactId = sanitizeId(trimToString(artifactIdRaw));
    if (!requestId || !artifactId) return { ok: false, statusCode: 400, error: "invalid_artifact_locator" };
    const cached = store.get(requestId);
    if (!cached || cached.status === "accepted") return { ok: false, statusCode: 404, error: "not_found" };
    const artifacts = Array.isArray(cached.artifacts) ? cached.artifacts : [];
    const artifact = artifacts.find(item => item.id === artifactId);
    if (!artifact) return { ok: false, statusCode: 404, error: "artifact_not_found" };
    if (artifact.expires_at) {
      const expiresAt = Date.parse(artifact.expires_at);
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        return { ok: false, statusCode: 410, error: "artifact_expired" };
      }
    }
    const filePath = trimToString(artifact.file_path);
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, statusCode: 404, error: "artifact_missing" };
    return {
      ok: true,
      artifact: {
        filePath,
        mime: trimToString(artifact.mime) || detectMime(filePath),
        filename: trimToString(artifact.filename) || path.basename(filePath),
        sizeBytes: Number.isFinite(Number(artifact.size_bytes)) ? Number(artifact.size_bytes) : resolveSizeBytes(filePath),
      },
    };
  }

  return {
    enabled,
    token,
    postMessage,
    getMessage,
    getArtifact,
  };
}
