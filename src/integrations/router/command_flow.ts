import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { appendLedger } from "../audit/ledger.js";
import { getStatusFacts } from "./context.js";
import { loadAuth, saveAuth } from "../auth/store.js";
import { evaluate } from "../../core/config/index.js";
import type { LoadedConfig } from "../../core/config/types.js";
import { rejectText } from "../runtime/response_templates.js";
import { COMMAND_MESSAGES, INTERACTION_MESSAGES } from "./intent_policy.js";
import { ACCESS_MESSAGES } from "./intent_policy.js";
import { nowIso } from "./router_utils.js";
import type { SendFn } from "./router_types.js";
import { resolveProjectId } from "./intent_handlers.js";
import { setLastAlert } from "./state_cache.js";
import { postJson } from "../runtime/http_client.js";

export type ParsedCommand = ReturnType<typeof import("./commands.js").parseCommand>;

type OpsLimits = {
  maxLinesDefault: number;
  maxLogChars: number;
  telegramSafeMax: number;
};

function formatErrorDetail(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const encoded = JSON.stringify(value);
    return encoded && encoded !== "{}" ? encoded : "";
  } catch {
    return String(value);
  }
}

function getOpsLimits(): OpsLimits {
  const telegramSafeMax = 3500;
  const maxLinesDefault = Number(process.env.GW_MAX_LOG_LINES || 200);
  const maxLogChars = Math.min(
    Number(process.env.GW_MAX_LOG_CHARS || telegramSafeMax),
    telegramSafeMax,
  );
  return { maxLinesDefault, maxLogChars, telegramSafeMax };
}

function clampLines(n: number, maxLinesDefault: number) {
  if (!Number.isFinite(n) || n <= 0) return 80;
  return Math.min(Math.max(1, Math.floor(n)), maxLinesDefault);
}

function pm2Jlist(): any[] {
  try {
    const out = execSync("pm2 jlist", { encoding: "utf-8" });
    return JSON.parse(out);
  } catch {
    return [];
  }
}

function fmtUptime(ms: number) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d${h % 24}h`;
  if (h > 0) return `${h}h${m % 60}m`;
  return `${m}m`;
}

function renderPs(allowedNames: string[]) {
  const now = Date.now();
  const rows = pm2Jlist()
    .filter((p) => !allowedNames.length || allowedNames.includes(p?.name))
    .map((p) => {
      const name = p?.name || "unknown";
      const status = p?.pm2_env?.status || "unknown";
      const restarts = p?.pm2_env?.restart_time ?? 0;
      const pmUptime = p?.pm2_env?.pm_uptime ?? 0;
      const uptime = pmUptime ? fmtUptime(now - pmUptime) : "—";
      const memMb = p?.monit?.memory ? (p.monit.memory / (1024 * 1024)).toFixed(1) : "0.0";
      const cpu = p?.monit?.cpu ?? 0;
      return { name, status, uptime, restarts, memMb, cpu };
    });

  const lines: string[] = [];
  lines.push("🧾 pm2 (facts-only)");
  if (!rows.length) {
    lines.push("- (no pm2 data)");
  }
  for (const r of rows) {
    lines.push(`- ${r.name}: ${r.status} | up ${r.uptime} | restarts ${r.restarts} | mem ${r.memMb}MB | cpu ${r.cpu}%`);
  }
  return lines.join("\n");
}

function renderStatus(allowedNames: string[]) {
  const nowUtc = new Date().toISOString();
  let sha = "unknown";
  try {
    sha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {}

  const procs = pm2Jlist();
  const byName = new Map<string, any>();
  for (const p of procs) byName.set(p?.name, p);
  const pick = (name: string) => {
    const p = byName.get(name);
    const st = p?.pm2_env?.status || "unknown";
    return `${name}=${st}`;
  };

  const names = allowedNames.length ? allowedNames : [];
  const pm2Line = names.length
    ? names.map((n) => pick(n)).join(" ")
    : "(no pm2 names configured)";
  const bits = [
    `✅ status (facts-only)`,
    `- time_utc: ${nowUtc}`,
    `- repo_sha: ${sha}`,
    `- pm2: ${pm2Line}`,
  ];
  return bits.join("\n");
}

function resolvePm2LogPath(name: string, stream: "out" | "error") {
  const base = path.join(os.homedir(), ".pm2", "logs");
  return path.join(base, `${name}-${stream}.log`);
}

type VaReplyResult =
  | { ok: true; roomId: string; ticketId?: string }
  | { ok: false; error: string };

function normalizeOperatorReplyUrl(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (text.includes("/api/v1/public-agent/operator/reply")) return text;
  return `${text.replace(/\/+$/, "")}/api/v1/public-agent/operator/reply`;
}

function resolveOperatorBaseUrl(): string {
  const replyUrl = normalizeOperatorReplyUrl(String(process.env.PUBLIC_AGENT_OPERATOR_REPLY_URL || ""));
  if (!replyUrl) return "";
  return replyUrl.replace(/\/reply(?:\?.*)?$/i, "");
}

function operatorApiConfig() {
  const baseUrl = resolveOperatorBaseUrl();
  const token = String(process.env.PUBLIC_AGENT_OPERATOR_REPLY_TOKEN || "").trim();
  const timeoutRaw = Number(process.env.PUBLIC_AGENT_OPERATOR_REPLY_TIMEOUT_MS || 8000);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : 8000;
  return { baseUrl, token, timeoutMs };
}

function operatorIdentity(channel: string, chatId: string): string {
  return `${channel}:${chatId}`;
}

function operatorSessionsFile(storageDir: string): string {
  return path.join(storageDir, "va_operator_sessions.json");
}

type OperatorSession = {
  ticket_id: string;
  updated_at: string;
  operator_id: string;
};

type OperatorSessionMap = Record<string, OperatorSession>;

function loadOperatorSessions(storageDir: string): OperatorSessionMap {
  const file = operatorSessionsFile(storageDir);
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as OperatorSessionMap;
  } catch {
    return {};
  }
}

function saveOperatorSessions(storageDir: string, sessions: OperatorSessionMap) {
  const file = operatorSessionsFile(storageDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sessions, null, 2), "utf-8");
  } catch {
    // ignore
  }
}

function getActiveSession(storageDir: string, channel: string, chatId: string): OperatorSession | null {
  const sessions = loadOperatorSessions(storageDir);
  const key = operatorIdentity(channel, chatId);
  const row = sessions[key];
  if (!row || !String(row.ticket_id || "").trim()) return null;
  return row;
}

export function hasActiveOperatorSession(storageDir: string, channel: string, chatId: string): boolean {
  return Boolean(getActiveSession(storageDir, channel, chatId));
}

function setActiveSession(storageDir: string, channel: string, chatId: string, ticketId: string) {
  const sessions = loadOperatorSessions(storageDir);
  const key = operatorIdentity(channel, chatId);
  sessions[key] = {
    ticket_id: String(ticketId || "").trim().toUpperCase(),
    updated_at: nowIso(),
    operator_id: key,
  };
  saveOperatorSessions(storageDir, sessions);
}

function clearActiveSession(storageDir: string, channel: string, chatId: string) {
  const sessions = loadOperatorSessions(storageDir);
  const key = operatorIdentity(channel, chatId);
  if (sessions[key]) {
    delete sessions[key];
    saveOperatorSessions(storageDir, sessions);
  }
}

async function operatorApiCall(
  endpoint: string,
  body?: Record<string, any>,
  method: "GET" | "POST" = "POST",
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const { baseUrl, token, timeoutMs } = operatorApiConfig();
  if (!baseUrl) return { ok: false, error: "missing PUBLIC_AGENT_OPERATOR_REPLY_URL" };
  if (!token) return { ok: false, error: "missing PUBLIC_AGENT_OPERATOR_REPLY_TOKEN" };
  const url = `${baseUrl}/${endpoint.replace(/^\/+/, "")}`;
  let payload: any = null;
  if (method === "POST") {
    const res = await postJson(url, token, body || {}, { timeoutMs, retries: 0 });
    if (!res.ok) {
      const detailText = formatErrorDetail(res.error?.detail);
      const detail = detailText ? `: ${detailText}` : "";
      return { ok: false, error: `${res.error.code}${detail}` };
    }
    payload = res.data && typeof res.data === "object" ? res.data : {};
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: any = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = {};
      }
      if (!res.ok) {
        const detail = formatErrorDetail(parsed?.error) || text || "";
        return { ok: false, error: `http_${res.status}${detail ? `: ${String(detail).slice(0, 300)}` : ""}` };
      }
      payload = parsed && typeof parsed === "object" ? parsed : {};
    } catch (error: any) {
      const message = String(error?.name === "AbortError" ? "timeout" : error?.message || "fetch_failed");
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  const ok = Boolean((payload as any).ok);
  if (!ok) {
    const err = (payload as any).error;
    const message = err && typeof err === "object"
      ? String(err.message || err.code || "unknown")
      : "unknown";
    return { ok: false, error: `api_error: ${message}` };
  }
  return { ok: true, data: (payload as any).data || {} };
}

async function dispatchVaOperatorReply(ticketId: string, text: string, channel: string, chatId: string): Promise<VaReplyResult> {
  const body = {
    ticket_id: String(ticketId || "").trim().toUpperCase(),
    text,
    source: "chat_gateway",
    operator_id: operatorIdentity(channel, chatId),
  };
  const call = await operatorApiCall("reply", body, "POST");
  if (!call.ok) return { ok: false, error: String(call.error || "unknown_error") };
  const roomId = String(call.data?.room_id || "").trim();
  const rtTicket = String(call.data?.ticket_id || body.ticket_id).trim().toUpperCase();
  return { ok: true, roomId, ticketId: rtTicket };
}

async function dispatchVaOperatorTake(ticketId: string, channel: string, chatId: string) {
  return operatorApiCall(
    "take",
    {
      ticket_id: String(ticketId || "").trim().toUpperCase(),
      source: "chat_gateway",
      operator_id: operatorIdentity(channel, chatId),
    },
    "POST",
  );
}

async function dispatchVaOperatorClose(ticketId: string, channel: string, chatId: string) {
  return operatorApiCall(
    "close",
    {
      ticket_id: String(ticketId || "").trim().toUpperCase(),
      source: "chat_gateway",
      operator_id: operatorIdentity(channel, chatId),
    },
    "POST",
  );
}

async function dispatchVaOperatorReject(ticketId: string, reason: string, channel: string, chatId: string) {
  return operatorApiCall(
    "reject",
    {
      ticket_id: String(ticketId || "").trim().toUpperCase(),
      reason: String(reason || "").trim(),
      source: "chat_gateway",
      operator_id: operatorIdentity(channel, chatId),
    },
    "POST",
  );
}

async function dispatchVaOperatorInbox() {
  return operatorApiCall("inbox?limit=10", {}, "GET");
}

async function dispatchVaOperatorStatus(ticketId: string) {
  const encoded = encodeURIComponent(String(ticketId || "").trim().toUpperCase());
  return operatorApiCall(`status?ticket_id=${encoded}`, {}, "GET");
}

async function dispatchVaOperatorReplyByContactId(contactId: string, text: string): Promise<VaReplyResult> {
  const url = normalizeOperatorReplyUrl(String(process.env.PUBLIC_AGENT_OPERATOR_REPLY_URL || ""));
  const token = String(process.env.PUBLIC_AGENT_OPERATOR_REPLY_TOKEN || "").trim();
  const timeoutRaw = Number(process.env.PUBLIC_AGENT_OPERATOR_REPLY_TIMEOUT_MS || 8000);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : 8000;

  if (!url) return { ok: false, error: "missing PUBLIC_AGENT_OPERATOR_REPLY_URL" };
  if (!token) return { ok: false, error: "missing PUBLIC_AGENT_OPERATOR_REPLY_TOKEN" };

  const body = {
    contact_id: contactId,
    text,
    source: "chat_gateway",
    operator_id: "chat_gateway",
  };
  const res = await postJson(url, token, body, { timeoutMs, retries: 0 });
  if (!res.ok) {
    const detail = res.error?.detail ? `: ${res.error.detail}` : "";
    return { ok: false, error: `${res.error.code}${detail}` };
  }
  const payload = res.data && typeof res.data === "object" ? res.data : {};
  const ok = Boolean((payload as any).ok);
  if (!ok) {
    const err = (payload as any).error;
    const message = err && typeof err === "object"
      ? String(err.message || err.code || "unknown")
      : "unknown";
    return { ok: false, error: `api_error: ${message}` };
  }
  const roomId = String((payload as any).data?.room_id || "").trim();
  return { ok: true, roomId };
}

function tailFile(filePath: string, n: number): string {
  const cmd = `tail -n ${n} ${filePath.replace(/(["\\$`])/g, "\\$1")}`;
  return execSync(cmd, { encoding: "utf-8" });
}

function renderLogs(name: string, lines: number, maxLinesDefault: number) {
  const n = clampLines(lines, maxLinesDefault);
  const outPath = resolvePm2LogPath(name, "out");
  const errPath = resolvePm2LogPath(name, "error");
  const chunks: string[] = [];
  chunks.push(`📜 logs: ${name} (last ${n})`);

  if (fs.existsSync(errPath)) {
    try {
      const t = tailFile(errPath, n).trimEnd();
      if (t) {
        chunks.push("--- error ---");
        chunks.push(t);
      }
    } catch {}
  }
  if (fs.existsSync(outPath)) {
    try {
      const t = tailFile(outPath, n).trimEnd();
      if (t) {
        chunks.push("--- out ---");
        chunks.push(t);
      }
    } catch {}
  }

  if (chunks.length <= 1) {
    return `⚠️ logs unavailable: no pm2 log files for '${name}'`;
  }
  return chunks.join("\n");
}

export async function handleOpsCommand(params: {
  storageDir: string;
  channel: string;
  cleanedText: string;
  config?: LoadedConfig;
  chatId: string;
  userId: string;
  mentionsBot: boolean;
  trimmedReplyText: string;
  isGroup: boolean;
  allowed: boolean;
  send: SendFn;
}): Promise<boolean> {
  const {
    storageDir,
    channel,
    cleanedText,
    config,
    chatId,
    userId,
    mentionsBot,
    trimmedReplyText,
    isGroup,
    allowed,
    send,
  } = params;

  if (!cleanedText.startsWith("/status") && !cleanedText.startsWith("/ps") && !cleanedText.startsWith("/logs")) {
    return false;
  }

  const { maxLinesDefault, maxLogChars, telegramSafeMax } = getOpsLimits();
  const pm2LogsNames = getPm2Names(config, "pm2_logs");
  const pm2PsNames = getPm2Names(config, "pm2_ps");
  const chatType = isGroup ? "group" : "private";
  const policyOk = config?.meta?.policyOk === true;
  const evalOps = (capability: string) => evaluate(config, {
    channel,
    capability,
    chat_id: chatId,
    chat_type: chatType,
    user_id: userId,
    mention_bot: mentionsBot,
    has_reply: Boolean(trimmedReplyText),
  });

  if (cleanedText.startsWith("/status")) {
    const res = evalOps("ops.status");
    if (res.require?.mention_bot_for_ops && !mentionsBot) return true;
    const isAllowed = policyOk ? res.allowed : allowed;
    if (!isAllowed) {
      await send(chatId, res.deny_message || rejectText(ACCESS_MESSAGES.ownerOnlyExplain));
      return true;
    }
    const status = renderStatus(pm2PsNames);
    const feedback = getStatusFacts(storageDir).split("\n").slice(1);
    const out = feedback.length ? `${status}\n${feedback.join("\n")}` : status;
    await send(chatId, out);
    return true;
  }

  if (cleanedText.startsWith("/ps")) {
    const res = evalOps("ops.ps");
    if (res.require?.mention_bot_for_ops && !mentionsBot) return true;
    const isAllowed = policyOk ? res.allowed : allowed;
    if (!isAllowed) {
      await send(chatId, res.deny_message || rejectText(ACCESS_MESSAGES.ownerOnlyExplain));
      return true;
    }
    await send(chatId, renderPs(pm2PsNames));
    return true;
  }

  if (cleanedText.startsWith("/logs")) {
    const res = evalOps("ops.logs");
    if (res.require?.mention_bot_for_ops && !mentionsBot) return true;
    const isAllowed = policyOk ? res.allowed : allowed;
    if (!isAllowed) {
      await send(chatId, res.deny_message || rejectText(ACCESS_MESSAGES.ownerOnlyExplain));
      return true;
    }
    const parts = cleanedText.split(/\s+/).filter(Boolean);
    if (!pm2LogsNames.length) {
      await send(chatId, "⚠️ 未配置 pm2 日志进程名（manifest: pm2_logs.names）。");
      return true;
    }
    const name = parts[1] || pm2LogsNames[0];
    if (!pm2LogsNames.includes(name)) {
      await send(chatId, `⚠️ 不允许的进程名：${name}`);
      return true;
    }
    const lines = parts[2] ? Number(parts[2]) : 80;
    const out = renderLogs(name, lines, maxLinesDefault);
    if (out.length > maxLogChars) {
      const head = out.slice(0, Math.max(0, maxLogChars - 40));
      const msg =
        `⚠️ 输出过长，已截断到 ${maxLogChars} 字符（上限 ${telegramSafeMax}）。\n` +
        head +
        "\n...(clipped)";
      await send(chatId, msg);
      return true;
    }
    await send(chatId, out);
    return true;
  }

  return false;
}

export async function handlePrivateMessage(params: {
  channel: string;
  storageDir: string;
  chatId: string;
  isOwner: boolean;
  userId: string;
  messageId: string;
  replyToId: string;
  trimmedText: string;
  trimmedReplyText: string;
  isCommand: boolean;
  send: SendFn;
  config?: LoadedConfig;
}): Promise<boolean> {
  const {
    channel,
    storageDir,
    chatId,
    isOwner,
    userId,
    messageId,
    replyToId,
    trimmedText,
    trimmedReplyText,
    isCommand,
  send,
  config,
  } = params;

  if (trimmedReplyText) {
    setLastAlert(storageDir, chatId, trimmedReplyText);
  }

  if (trimmedText === "/help" || trimmedText === "help") {
    await send(chatId, INTERACTION_MESSAGES.quickHelp);
    return true;
  }

  if (isCommand) {
    return false;
  }

  if (!isOwner) return false;
  const text = String(trimmedText || "").trim();
  if (!text) return false;
  const active = getActiveSession(storageDir, channel, chatId);
  if (!active || !String(active.ticket_id || "").trim()) {
    return false;
  }
  const ticketId = String(active.ticket_id || "").trim().toUpperCase();
  const result = await dispatchVaOperatorReply(ticketId, text, channel, chatId);
  if (!result.ok) {
    const err = String(result.error || "");
    if (err.includes("manual_not_active") || err.includes("MANUAL_NOT_ACTIVE")) {
      clearActiveSession(storageDir, channel, chatId);
      await send(chatId, `⚠️ 会话 ${ticketId} 已不在人工接管状态，请先 /va inbox 再 /va take。`);
      return true;
    }
    await send(chatId, `❌ 人工回复转发失败（${ticketId}）：${err}`);
    return true;
  }
  appendLedger(storageDir, {
    ts_utc: nowIso(),
    channel,
    chat_id: chatId,
    user_id: userId,
    cmd: "va_manual_text",
    target: ticketId,
    room_id: result.roomId,
  });
  await send(chatId, `✅ 已转发到访客会话（ticket=${ticketId}）`);
  return true;
}

export async function handleParsedCommand(params: {
  cmd: ParsedCommand;
  channel: string;
  storageDir: string;
  chatId: string;
  userId: string;
  text: string;
  isOwner: boolean;
  authState: ReturnType<typeof loadAuth>;
  send: SendFn;
  config?: LoadedConfig;
}) {
  const { cmd, channel, storageDir, chatId, userId, text, isOwner, authState, send, config } = params;

  // auth commands only owner
  if (cmd.kind.startsWith("auth_") && !isOwner) {
    await send(chatId, rejectText(COMMAND_MESSAGES.authDenied));
    return;
  }

  const ts = nowIso();
  const baseAudit = { ts_utc: ts, channel, chat_id: chatId, user_id: userId, raw: text };

  if (cmd.kind === "help") {
    const out = [
      "/help",
      "/i <自然语言>",
      "/status",
      "/ps",
      "/logs <name> [lines]",
      "/va help",
      "/va inbox",
      "/va take <ticket_id>",
      "/va close [ticket_id]",
      "/va reject <ticket_id> [原因]",
      "/va status <ticket_id>",
      "/auth add <chat_id>",
      "/auth del <chat_id>",
      "/auth list",
      "/feedback <描述>（例如：告警太多了 / 只推高等级）",
      "/chart <query>（仅 Telegram）",
    ].join("\n");
    await send(chatId, out);
    appendLedger(storageDir, { ...baseAudit, cmd: "help" });
    return;
  }

  if (cmd.kind === "auth_list") {
    const out = `allowed:\n- ${authState.allowed.join("\n- ")}`;
    await send(chatId, out);
    appendLedger(storageDir, { ...baseAudit, cmd: "auth_list" });
    return;
  }

  if (cmd.kind === "auth_add") {
    if (!authState.allowed.includes(cmd.id)) authState.allowed.push(cmd.id);
    saveAuth(storageDir, authState, channel);
    await send(chatId, `added ${cmd.id}`);
    appendLedger(storageDir, { ...baseAudit, cmd: "auth_add", target: cmd.id });
    return;
  }

  if (cmd.kind === "auth_del") {
    authState.allowed = authState.allowed.filter((x) => x !== cmd.id);
    saveAuth(storageDir, authState, channel);
    await send(chatId, `deleted ${cmd.id}`);
    appendLedger(storageDir, { ...baseAudit, cmd: "auth_del", target: cmd.id });
    return;
  }

  if (cmd.kind === "va_help") {
    const out = [
      "人工接管命令：",
      "- /va inbox",
      "- /va take <ticket_id>",
      "- /va close [ticket_id]",
      "- /va reject <ticket_id> [原因]",
      "- /va status <ticket_id>",
      "提示：接管后可直接发送普通文本，无需每条都带命令。",
    ].join("\n");
    await send(chatId, out);
    appendLedger(storageDir, { ...baseAudit, cmd: "va_help" });
    return;
  }

  if (cmd.kind === "va_inbox") {
    if (!isOwner) {
      await send(chatId, rejectText(COMMAND_MESSAGES.authDenied));
      appendLedger(storageDir, { ...baseAudit, cmd: "va_inbox_denied" });
      return;
    }
    const result = await dispatchVaOperatorInbox();
    if (!result.ok) {
      await send(chatId, `❌ 查询失败：${result.error}`);
      appendLedger(storageDir, { ...baseAudit, cmd: "va_inbox_failed", reason: result.error });
      return;
    }
    const items = Array.isArray(result.data?.items) ? result.data.items : [];
    if (!items.length) {
      await send(chatId, "📭 当前没有待接管会话。");
      appendLedger(storageDir, { ...baseAudit, cmd: "va_inbox", count: 0 });
      return;
    }
    const lines = ["📥 人工接管会话："];
    for (const item of items) {
      const ticketId = String(item?.ticket_id || "").trim();
      const mode = String(item?.mode || "bot").trim();
      const latest = String(item?.latest_text || "").trim();
      const timeoutIn = Number(item?.timeout_in_seconds || 0);
      lines.push(`- ${ticketId} | ${mode} | timeout=${Math.max(0, timeoutIn)}s`);
      if (latest) lines.push(`  ${latest.slice(0, 120)}`);
    }
    await send(chatId, lines.join("\n"));
    appendLedger(storageDir, { ...baseAudit, cmd: "va_inbox", count: items.length });
    return;
  }

  if (cmd.kind === "va_take") {
    if (!isOwner) {
      await send(chatId, rejectText(COMMAND_MESSAGES.authDenied));
      appendLedger(storageDir, { ...baseAudit, cmd: "va_take_denied", target: cmd.ticketId });
      return;
    }
    const active = getActiveSession(storageDir, channel, chatId);
    if (active && String(active.ticket_id || "").trim().toUpperCase() !== cmd.ticketId) {
      await send(chatId, `⚠️ 你当前正在接管 ${active.ticket_id}，请先 /va close ${active.ticket_id}。`);
      appendLedger(storageDir, {
        ...baseAudit,
        cmd: "va_take_conflict",
        target: cmd.ticketId,
        active_ticket: active.ticket_id,
      });
      return;
    }
    const result = await dispatchVaOperatorTake(cmd.ticketId, channel, chatId);
    if (!result.ok) {
      await send(chatId, `❌ 接管失败：${result.error}`);
      appendLedger(storageDir, { ...baseAudit, cmd: "va_take_failed", target: cmd.ticketId, reason: result.error });
      return;
    }
    const ticketId = String(result.data?.ticket_id || cmd.ticketId).trim().toUpperCase();
    setActiveSession(storageDir, channel, chatId, ticketId);
    await send(chatId, `✅ 已接管 ${ticketId}。现在可直接发送文本进行人工回复。`);
    appendLedger(storageDir, { ...baseAudit, cmd: "va_take", target: ticketId });
    return;
  }

  if (cmd.kind === "va_close") {
    if (!isOwner) {
      await send(chatId, rejectText(COMMAND_MESSAGES.authDenied));
      appendLedger(storageDir, { ...baseAudit, cmd: "va_close_denied", target: cmd.ticketId });
      return;
    }
    const active = getActiveSession(storageDir, channel, chatId);
    const ticketId = String(cmd.ticketId || active?.ticket_id || "").trim().toUpperCase();
    if (!ticketId) {
      await send(chatId, "⚠️ 缺少 ticket_id。请先 /va inbox 查看会话。");
      appendLedger(storageDir, { ...baseAudit, cmd: "va_close_missing_ticket" });
      return;
    }
    const result = await dispatchVaOperatorClose(ticketId, channel, chatId);
    if (!result.ok) {
      const err = String(result.error || "");
      if (err.includes("manual_not_active") || err.includes("MANUAL_NOT_ACTIVE")) {
        clearActiveSession(storageDir, channel, chatId);
        await send(chatId, `ℹ️ 会话 ${ticketId} 已不在人工接管，已自动清理本地接管状态。`);
        appendLedger(storageDir, { ...baseAudit, cmd: "va_close_stale", target: ticketId, reason: err });
        return;
      }
      await send(chatId, `❌ 关闭失败：${result.error}`);
      appendLedger(storageDir, { ...baseAudit, cmd: "va_close_failed", target: ticketId, reason: result.error });
      return;
    }
    clearActiveSession(storageDir, channel, chatId);
    await send(chatId, `✅ 已关闭人工接管：${ticketId}`);
    appendLedger(storageDir, { ...baseAudit, cmd: "va_close", target: ticketId });
    return;
  }

  if (cmd.kind === "va_reject") {
    if (!isOwner) {
      await send(chatId, rejectText(COMMAND_MESSAGES.authDenied));
      appendLedger(storageDir, { ...baseAudit, cmd: "va_reject_denied", target: cmd.ticketId });
      return;
    }
    const result = await dispatchVaOperatorReject(cmd.ticketId, cmd.reason, channel, chatId);
    if (!result.ok) {
      await send(chatId, `❌ 拒绝失败：${result.error}`);
      appendLedger(storageDir, { ...baseAudit, cmd: "va_reject_failed", target: cmd.ticketId, reason: result.error });
      return;
    }
    clearActiveSession(storageDir, channel, chatId);
    await send(chatId, `✅ 已拒绝接管请求：${cmd.ticketId}`);
    appendLedger(storageDir, { ...baseAudit, cmd: "va_reject", target: cmd.ticketId });
    return;
  }

  if (cmd.kind === "va_status") {
    if (!isOwner) {
      await send(chatId, rejectText(COMMAND_MESSAGES.authDenied));
      appendLedger(storageDir, { ...baseAudit, cmd: "va_status_denied", target: cmd.ticketId });
      return;
    }
    const result = await dispatchVaOperatorStatus(cmd.ticketId);
    if (!result.ok) {
      await send(chatId, `❌ 查询失败：${result.error}`);
      appendLedger(storageDir, { ...baseAudit, cmd: "va_status_failed", target: cmd.ticketId, reason: result.error });
      return;
    }
    const data = result.data || {};
    const out = [
      `ticket=${String(data.ticket_id || cmd.ticketId).trim().toUpperCase()}`,
      `mode=${String(data.mode || "bot")}`,
      `waiting=${String(data.manual_waiting_side || "-")}`,
      `timeout_in=${Math.max(0, Number(data.timeout_in_seconds || 0))}s`,
    ].join("\n");
    await send(chatId, out);
    appendLedger(storageDir, { ...baseAudit, cmd: "va_status", target: cmd.ticketId });
    return;
  }

  if (cmd.kind === "va_reply") {
    if (!isOwner) {
      await send(chatId, rejectText(COMMAND_MESSAGES.authDenied));
      appendLedger(storageDir, { ...baseAudit, cmd: "va_reply_denied", target: cmd.contactId });
      return;
    }
    const result = await dispatchVaOperatorReplyByContactId(cmd.contactId, cmd.text);
    if (!result.ok) {
      await send(chatId, `❌ 转发失败：${result.error}`);
      appendLedger(storageDir, { ...baseAudit, cmd: "va_reply_failed", target: cmd.contactId, reason: result.error });
      return;
    }
    const label = String(result.ticketId || "").trim().toUpperCase();
    await send(chatId, label ? `✅ 已转发到访客会话（ticket=${label}）` : "✅ 已转发到访客会话（legacy）");
    appendLedger(storageDir, { ...baseAudit, cmd: "va_reply", target: cmd.contactId, room_id: result.roomId });
    return;
  }

  await send(chatId, INTERACTION_MESSAGES.unknownCommand);
  appendLedger(storageDir, { ...baseAudit, cmd: "unknown" });
}

function getProject(config?: LoadedConfig) {
  const projectId = resolveProjectId(config);
  if (!projectId) return null;
  const proj = (config?.projects || {})[projectId];
  if (!proj) return null;
  return { projectId, proj };
}

function getPm2Names(config: LoadedConfig | undefined, resourceKey: "pm2_logs" | "pm2_ps"): string[] {
  const p = getProject(config);
  if (!p) return [];
  const res: any = (p.proj as any)?.resources?.[resourceKey];
  const names = Array.isArray(res?.names) ? res.names : [];
  return names.map((n: unknown) => String(n)).filter((n: string) => Boolean(n));
}
