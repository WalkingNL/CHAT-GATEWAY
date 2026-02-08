import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileLimited } from "./exec_limiter.js";
import { loadProjectRegistry, resolveProjectNotifyTargets, tryLoadProjectRegistry } from "./project_registry.js";
import { resolveTargetOverrides, type TargetOverrides } from "../../core/notify_overrides.js";
import { createPublicInboundRuntime } from "./public_inbound.js";
import type { LoadedConfig } from "../../core/config/types.js";
let hupRegistered = false;

export type NotifySenders = {
  telegram?: {
    sendText: (chatId: string, text: string) => Promise<void>;
    sendImage: (chatId: string, imagePath: string, caption?: string) => Promise<void>;
  };
  feishu?: {
    sendText: (chatId: string, text: string) => Promise<void>;
    sendImage: (chatId: string, imagePath: string) => Promise<void>;
  };
};

type NotifyTarget = "telegram" | "feishu" | "both";

type NotifyBaseBody = {
  target?: NotifyTarget;
  project_id?: string;
  chat_id?: string | number;
  chat_ids?: Array<string | number> | { telegram?: Array<string | number>; feishu?: Array<string | number> };
  chat_ids_by_target?: { telegram?: Array<string | number>; feishu?: Array<string | number> };
  meta?: Record<string, any>;
  delivery_priority?: string;
  global_min_priority?: string;
  channel_min_priority?: string;
  priority?: string;
};

type NotifyTextBody = NotifyBaseBody & {
  text?: string;
};

type NotifyImageBody = NotifyBaseBody & {
  image_path?: string;
  image_url?: string;
  caption?: string;
};

function buildTargetOverrideMap(
  overrides: TargetOverrides,
  target: "telegram" | "feishu",
  chatIds: string[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const map = overrides[target] || {};
  for (const chatId of chatIds) {
    const entry = map[chatId];
    out[chatId] = entry?.min_priority || null;
  }
  return out;
}

function badRequest(res: http.ServerResponse, msg: string) {
  res.statusCode = 400;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: false, error: msg }));
}

function forbidden(res: http.ServerResponse, msg = "forbidden") {
  res.statusCode = 403;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: false, error: msg }));
}

function unauthorized(res: http.ServerResponse) {
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
}

function okJson(res: http.ServerResponse, body: any) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function normalizeRemoteAddress(addr: string | undefined): string {
  if (!addr) return "";
  if (addr === "::1") return "127.0.0.1";
  if (addr.startsWith("::ffff:")) return addr.slice(7);
  return addr;
}

function isInternalAddress(addr: string): boolean {
  if (!addr) return false;
  const lower = addr.toLowerCase();
  if (lower === "127.0.0.1") return true;
  if (lower.startsWith("10.")) return true;
  if (lower.startsWith("192.168.")) return true;
  if (lower.startsWith("172.")) {
    const parts = lower.split(".");
    const second = Number(parts[1]);
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
  }
  if (lower.startsWith("100.")) {
    const parts = lower.split(".");
    const second = Number(parts[1]);
    if (Number.isFinite(second) && second >= 64 && second <= 127) return true;
  }
  if (lower.startsWith("169.254.")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80")) return true;
  return false;
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf-8") || "{}";
  return JSON.parse(raw);
}

function toStrList(val: any): string[] {
  if (Array.isArray(val)) return val.map(v => String(v)).filter(Boolean);
  if (val == null) return [];
  return [String(val)];
}

function normalizeTarget(raw: any): NotifyTarget {
  const t = String(raw || "both").toLowerCase();
  if (t === "telegram" || t === "feishu" || t === "both") return t;
  return "both";
}

const DEFAULT_PRIORITY_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const PRIORITY_ORDER = (() => {
  const raw = String(process.env.CHAT_GATEWAY_PRIORITY_LEVELS || process.env.GW_PRIORITY_LEVELS || "").trim();
  if (!raw) return DEFAULT_PRIORITY_ORDER;
  const parts = raw.split(/[\s,]+/).map(p => p.trim().toUpperCase()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (!out.includes(p)) out.push(p);
  }
  return out.length ? out : DEFAULT_PRIORITY_ORDER;
})();

function normalizePriority(raw: any, fallback?: string): string | null {
  const s = String(raw || "").trim().toUpperCase();
  if (s && PRIORITY_ORDER.includes(s)) return s;
  const fb = String(fallback || "").trim().toUpperCase();
  if (fb && PRIORITY_ORDER.includes(fb)) return fb;
  return null;
}

function priorityRank(level: string | null): number {
  if (!level) return -1;
  const idx = PRIORITY_ORDER.indexOf(level);
  return idx >= 0 ? idx : -1;
}

function maxPriority(...levels: Array<string | null | undefined>): string {
  const lowest = PRIORITY_ORDER[0] || "LOW";
  let best: string | null = null;
  for (const lvl of levels) {
    const norm = normalizePriority(lvl || "");
    if (!norm) continue;
    if (!best || priorityRank(norm) > priorityRank(best)) {
      best = norm;
    }
  }
  return best || lowest;
}

function extractGateInfo(body: NotifyBaseBody) {
  const lowest = PRIORITY_ORDER[0] || "LOW";
  const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
  const skipGate = Boolean((meta as any).skip_gate);
  const deliveryRaw = (meta as any).delivery_priority ?? (body as any).delivery_priority ?? (body as any).priority;
  const deliveryPriority = normalizePriority(deliveryRaw);
  if (!deliveryPriority) {
    return skipGate ? { skip_gate: true as const } : null;
  }

  const globalMin = normalizePriority((meta as any).global_min_priority ?? (body as any).global_min_priority, lowest) || lowest;
  const channelMin = normalizePriority((meta as any).channel_min_priority ?? (body as any).channel_min_priority, globalMin) || globalMin;
  return {
    skip_gate: skipGate,
    delivery_priority: deliveryPriority,
    global_min_priority: globalMin,
    channel_min_priority: channelMin,
  };
}

type GateDecision = {
  allowed: boolean;
  effectiveMin: string | null;
  skipReason: string | null;
};

function decideGate(gate: ReturnType<typeof extractGateInfo>, override: string | null): GateDecision {
  if (!gate) {
    return { allowed: false, effectiveMin: null, skipReason: "missing_gate_meta" };
  }
  if (gate.skip_gate) {
    return { allowed: true, effectiveMin: null, skipReason: "skip_gate" };
  }
  const effectiveMin = maxPriority(gate.global_min_priority, gate.channel_min_priority, override);
  const allowed = priorityRank(gate.delivery_priority || "") >= priorityRank(effectiveMin);
  return { allowed, effectiveMin, skipReason: allowed ? null : "below_min_priority" };
}

function extractExplicitChatIds(body: NotifyBaseBody) {
  const directSource = body.chat_id ?? (Array.isArray(body.chat_ids) ? body.chat_ids : undefined);
  const direct = toStrList(directSource);
  const mapFromChatIds =
    body.chat_ids && typeof body.chat_ids === "object" && !Array.isArray(body.chat_ids)
      ? body.chat_ids
      : undefined;
  const map = body.chat_ids_by_target || mapFromChatIds || {};
  return {
    direct,
    telegram: toStrList((map as any).telegram),
    feishu: toStrList((map as any).feishu),
  };
}

function resolveChatIds(body: NotifyBaseBody, registry: ReturnType<typeof loadProjectRegistry>) {
  const target = normalizeTarget(body.target);
  const explicit = extractExplicitChatIds(body);
  if (target === "both" && explicit.direct.length) {
    return { ok: false as const, error: "chat_id_requires_single_target" };
  }

  const defaults = resolveProjectNotifyTargets(registry, body.project_id);

  const telegram = explicit.telegram.length
    ? explicit.telegram
    : (target === "telegram" ? (explicit.direct.length ? explicit.direct : defaults.telegram) : defaults.telegram);
  const feishu = explicit.feishu.length
    ? explicit.feishu
    : (target === "feishu" ? (explicit.direct.length ? explicit.direct : defaults.feishu) : defaults.feishu);

  if (target === "telegram" && !telegram.length) return { ok: false as const, error: "missing_telegram_chat_ids" };
  if (target === "feishu" && !feishu.length) return { ok: false as const, error: "missing_feishu_chat_ids" };
  if (target === "both" && (!telegram.length || !feishu.length)) {
    return { ok: false as const, error: "missing_chat_ids_for_both" };
  }

  return { ok: true as const, target, telegram, feishu };
}

async function downloadToTempFile(url: string): Promise<{ path: string; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-gateway-"));
  const outPath = path.join(dir, `notify_${Date.now()}.img`);
  await execFileLimited("notify", "curl", [
    "-4",
    "-sS",
    "--fail",
    "--connect-timeout",
    "5",
    "--max-time",
    "45",
    "-L",
    "-o",
    outPath,
    url,
  ]);
  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  return { path: outPath, cleanup };
}

async function sendTextToTargets(body: NotifyTextBody, senders: NotifySenders, registry: ReturnType<typeof loadProjectRegistry>) {
  const resolved = resolveChatIds(body, registry);
  if (!resolved.ok) return { ok: false as const, error: resolved.error };
  const overrides = resolveTargetOverrides(registry, body.project_id);
  const targetOverrides = {
    telegram: buildTargetOverrideMap(overrides, "telegram", resolved.telegram),
    feishu: buildTargetOverrideMap(overrides, "feishu", resolved.feishu),
  };
  const gate = extractGateInfo(body);
  const sent: Record<string, Record<string, any>> = { telegram: {}, feishu: {} };

  const text = String(body.text || "").trim();
  if (!text) return { ok: false as const, error: "missing_text" };

  if ((resolved.target === "telegram" || resolved.target === "both") && senders.telegram) {
    for (const chatId of resolved.telegram) {
      const override = normalizePriority(overrides.telegram?.[chatId]?.min_priority);
      const decision = decideGate(gate, override);
      if (!decision.allowed) {
        sent.telegram[chatId] = {
          sent: false,
          delivery_priority: gate?.delivery_priority ?? null,
          global_min_priority: gate?.global_min_priority ?? null,
          channel_min_priority: gate?.channel_min_priority ?? null,
          target_override_min_priority: override || null,
          effective_min_priority: decision.effectiveMin,
          skip_reason: decision.skipReason,
        };
        continue;
      }
      await senders.telegram.sendText(chatId, text);
      sent.telegram[chatId] = {
        sent: true,
        delivery_priority: gate?.delivery_priority ?? null,
        global_min_priority: gate?.global_min_priority ?? null,
        channel_min_priority: gate?.channel_min_priority ?? null,
        target_override_min_priority: override || null,
        effective_min_priority: decision.effectiveMin,
        skip_reason: decision.skipReason,
      };
    }
  }

  if ((resolved.target === "feishu" || resolved.target === "both") && senders.feishu) {
    for (const chatId of resolved.feishu) {
      const override = normalizePriority(overrides.feishu?.[chatId]?.min_priority);
      const decision = decideGate(gate, override);
      if (!decision.allowed) {
        sent.feishu[chatId] = {
          sent: false,
          delivery_priority: gate?.delivery_priority ?? null,
          global_min_priority: gate?.global_min_priority ?? null,
          channel_min_priority: gate?.channel_min_priority ?? null,
          target_override_min_priority: override || null,
          effective_min_priority: decision.effectiveMin,
          skip_reason: decision.skipReason,
        };
        continue;
      }
      await senders.feishu.sendText(chatId, text);
      sent.feishu[chatId] = {
        sent: true,
        delivery_priority: gate?.delivery_priority ?? null,
        global_min_priority: gate?.global_min_priority ?? null,
        channel_min_priority: gate?.channel_min_priority ?? null,
        target_override_min_priority: override || null,
        effective_min_priority: decision.effectiveMin,
        skip_reason: decision.skipReason,
      };
    }
  }

  return { ok: true as const, target_overrides: targetOverrides, sent };
}

async function sendImageToTargets(body: NotifyImageBody, senders: NotifySenders, registry: ReturnType<typeof loadProjectRegistry>) {
  const resolved = resolveChatIds(body, registry);
  if (!resolved.ok) return { ok: false as const, error: resolved.error };
  const overrides = resolveTargetOverrides(registry, body.project_id);
  const targetOverrides = {
    telegram: buildTargetOverrideMap(overrides, "telegram", resolved.telegram),
    feishu: buildTargetOverrideMap(overrides, "feishu", resolved.feishu),
  };
  const gate = extractGateInfo(body as NotifyBaseBody);
  const sent: Record<string, Record<string, any>> = { telegram: {}, feishu: {} };

  const caption = body.caption ? String(body.caption) : "";
  const imagePath = body.image_path ? String(body.image_path) : "";
  const imageUrl = body.image_url ? String(body.image_url) : "";
  if (!imagePath && !imageUrl) return { ok: false as const, error: "missing_image_path_or_url" };

  let localPath = imagePath;
  let cleanup: (() => void) | null = null;
  if (!localPath) {
    const res = await downloadToTempFile(imageUrl);
    localPath = res.path;
    cleanup = res.cleanup;
  }

  if (!fs.existsSync(localPath)) {
    if (cleanup) cleanup();
    return { ok: false as const, error: "image_not_found" };
  }

  try {
    if ((resolved.target === "telegram" || resolved.target === "both") && senders.telegram) {
      for (const chatId of resolved.telegram) {
        const override = normalizePriority(overrides.telegram?.[chatId]?.min_priority);
        const decision = decideGate(gate, override);
        if (!decision.allowed) {
          sent.telegram[chatId] = {
            sent: false,
            delivery_priority: gate?.delivery_priority ?? null,
            global_min_priority: gate?.global_min_priority ?? null,
            channel_min_priority: gate?.channel_min_priority ?? null,
            target_override_min_priority: override || null,
            effective_min_priority: decision.effectiveMin,
            skip_reason: decision.skipReason,
          };
          continue;
        }
        await senders.telegram.sendImage(chatId, localPath, caption || undefined);
        sent.telegram[chatId] = {
          sent: true,
          delivery_priority: gate?.delivery_priority ?? null,
          global_min_priority: gate?.global_min_priority ?? null,
          channel_min_priority: gate?.channel_min_priority ?? null,
          target_override_min_priority: override || null,
          effective_min_priority: decision.effectiveMin,
          skip_reason: decision.skipReason,
        };
      }
    }

    if ((resolved.target === "feishu" || resolved.target === "both") && senders.feishu) {
      for (const chatId of resolved.feishu) {
        const override = normalizePriority(overrides.feishu?.[chatId]?.min_priority);
        const decision = decideGate(gate, override);
        if (!decision.allowed) {
          sent.feishu[chatId] = {
            sent: false,
            delivery_priority: gate?.delivery_priority ?? null,
            global_min_priority: gate?.global_min_priority ?? null,
            channel_min_priority: gate?.channel_min_priority ?? null,
            target_override_min_priority: override || null,
            effective_min_priority: decision.effectiveMin,
            skip_reason: decision.skipReason,
          };
          continue;
        }
        if (caption) {
          await senders.feishu.sendText(chatId, caption);
        }
        await senders.feishu.sendImage(chatId, localPath);
        sent.feishu[chatId] = {
          sent: true,
          delivery_priority: gate?.delivery_priority ?? null,
          global_min_priority: gate?.global_min_priority ?? null,
          channel_min_priority: gate?.channel_min_priority ?? null,
          target_override_min_priority: override || null,
          effective_min_priority: decision.effectiveMin,
          skip_reason: decision.skipReason,
        };
      }
    }
  } finally {
    if (cleanup) cleanup();
  }

  return { ok: true as const, target_overrides: targetOverrides, sent };
}

export function startNotifyServer(opts: {
  host: string;
  port: number;
  token: string;
  senders: NotifySenders;
  cfg: any;
  loaded: LoadedConfig;
  storageDir: string;
}) {
  const registryPath = String(process.env.PROJECTS_REGISTRY_PATH || "config/projects.yml");
  const initial = tryLoadProjectRegistry(registryPath);
  let registry = initial.ok ? initial.data : { projects: {} };
  let lastGoodHash = initial.ok ? hashRegistryFile(registryPath) : "unknown";
  let registryMtimeMs = readRegistryMtime(registryPath);
  if (!initial.ok) {
    console.warn(`[registry][WARN] initial load failed: ${initial.error || "unknown"}`);
  }
  let lastRegistryCheckMs = 0;
  const { host, port, token, senders } = opts;
  if (!token) throw new Error("Missing CHAT_GATEWAY_TOKEN");
  const publicInbound = createPublicInboundRuntime({
    cfg: opts.cfg,
    loaded: opts.loaded,
    storageDir: opts.storageDir,
  });

  const reloadRegistry = (reason: string, mtimeOverride?: number) => {
    const mtime = mtimeOverride ?? readRegistryMtime(registryPath);
    const res = tryLoadProjectRegistry(registryPath);
    if (res.ok) {
      const nextHash = hashRegistryFile(registryPath);
      const prevHash = lastGoodHash;
      registry = res.data;
      lastGoodHash = nextHash;
      console.log(`[registry] reloaded (${reason}) hash ${prevHash} -> ${nextHash}`);
    } else {
      console.warn(
        `[registry][WARN] reload failed (${reason}) keep hash ${lastGoodHash}: ${res.error || "unknown"}`,
      );
    }
    registryMtimeMs = mtime;
  };

  const maybeReloadRegistry = () => {
    const now = Date.now();
    if (now - lastRegistryCheckMs < 1000) return;
    lastRegistryCheckMs = now;
    const mtime = readRegistryMtime(registryPath);
    if (mtime !== registryMtimeMs) {
      reloadRegistry("mtime", mtime);
    }
  };

  if (!hupRegistered) {
    process.on("SIGHUP", () => reloadRegistry("signal"));
    hupRegistered = true;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    const isPublicInboundPost = req.method === "POST" && url.pathname === "/v1/inbound/messages";
    const isPublicInboundGet = req.method === "GET" && /^\/v1\/inbound\/messages\/[^/]+$/.test(url.pathname);
    const publicInboundArtifactMatch = req.method === "GET"
      ? url.pathname.match(/^\/v1\/inbound\/artifacts\/([^/]+)\/([^/]+)\/(download|preview)$/)
      : null;
    const isPublicInboundArtifactGet = Boolean(publicInboundArtifactMatch);
    const isPublicInbound = isPublicInboundPost || isPublicInboundGet || isPublicInboundArtifactGet;

    const auth = String(req.headers["authorization"] || "");
    if (isPublicInbound) {
      if (!publicInbound.enabled) return forbidden(res, "public_api_disabled");
      if (auth !== `Bearer ${publicInbound.token}`) return unauthorized(res);
      if (isPublicInboundPost) {
        let body: any;
        try {
          body = await readJson(req);
        } catch {
          return badRequest(res, "invalid_json");
        }
        const idempotencyKey = String(req.headers["x-idempotency-key"] || "").trim();
        const clientId = String(req.headers["x-client-id"] || "").trim();
        const out = await publicInbound.postMessage(
          body,
          idempotencyKey || undefined,
          clientId || undefined,
        );
        if (!out.ok) {
          res.statusCode = out.statusCode;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: out.error }));
          return;
        }
        return okJson(res, out.response);
      }
      if (isPublicInboundArtifactGet) {
        let requestId = "";
        let artifactId = "";
        let mode: "download" | "preview" = "download";
        try {
          requestId = decodeURIComponent(publicInboundArtifactMatch![1] || "");
          artifactId = decodeURIComponent(publicInboundArtifactMatch![2] || "");
          mode = (publicInboundArtifactMatch![3] || "download") as "download" | "preview";
        } catch {
          return badRequest(res, "invalid_artifact_locator");
        }
        const out = publicInbound.getArtifact(requestId, artifactId);
        if (!out.ok) {
          res.statusCode = out.statusCode;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: out.error }));
          return;
        }
        const safeName = out.artifact.filename.replace(/[\r\n"]/g, "_") || "artifact.bin";
        res.statusCode = 200;
        res.setHeader("Content-Type", out.artifact.mime || "application/octet-stream");
        if (Number.isFinite(out.artifact.sizeBytes as number)) {
          res.setHeader("Content-Length", String(out.artifact.sizeBytes));
        }
        res.setHeader("Content-Disposition", `${mode === "preview" ? "inline" : "attachment"}; filename="${safeName}"`);
        res.setHeader("Cache-Control", "private, max-age=300");
        const stream = fs.createReadStream(out.artifact.filePath);
        stream.on("error", () => {
          if (!res.headersSent) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "artifact_missing" }));
            return;
          }
          res.destroy();
        });
        stream.pipe(res);
        return;
      }
      let requestId = "";
      try {
        requestId = decodeURIComponent(url.pathname.split("/").pop() || "");
      } catch {
        return badRequest(res, "invalid_request_id");
      }
      const out = publicInbound.getMessage(requestId);
      if (!out.ok) {
        res.statusCode = out.statusCode;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: out.error }));
        return;
      }
      return okJson(res, out.response);
    }

    const remote = normalizeRemoteAddress(req.socket.remoteAddress);
    if (!isInternalAddress(remote)) return forbidden(res);
    maybeReloadRegistry();
    if (auth !== `Bearer ${token}`) return unauthorized(res);

    if (req.method === "GET" && url.pathname === "/health") {
      return okJson(res, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/v1/notify/text") {
      let body: NotifyTextBody;
      try {
        body = await readJson(req);
      } catch {
        return badRequest(res, "invalid_json");
      }

      try {
        const out = await sendTextToTargets(body, senders, registry);
        if (!out.ok) return badRequest(res, out.error);
        return okJson(res, out);
      } catch (e: any) {
        return badRequest(res, `notify_failed:${String(e?.message || e)}`);
      }
    }

    if (req.method === "POST" && url.pathname === "/v1/notify/image") {
      let body: NotifyImageBody;
      try {
        body = await readJson(req);
      } catch {
        return badRequest(res, "invalid_json");
      }

      try {
        const out = await sendImageToTargets(body, senders, registry);
        if (!out.ok) return badRequest(res, out.error);
        return okJson(res, out);
      } catch (e: any) {
        return badRequest(res, `notify_failed:${String(e?.message || e)}`);
      }
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  server.listen(port, host, () => {
    console.log(`[notify] listening on http://${host}:${port}`);
  });

  return server;
}

function readRegistryMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function hashRegistryFile(filePath: string): string {
  try {
    const raw = fs.readFileSync(filePath);
    return createHash("sha256").update(raw).digest("hex").slice(0, 12);
  } catch {
    return "missing";
  }
}
