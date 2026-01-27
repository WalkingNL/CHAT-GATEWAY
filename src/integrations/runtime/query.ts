import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import YAML from "yaml";
import { appendLedger } from "../audit/ledger.js";
import { rejectText } from "./response_templates.js";
import type { LoadedConfig } from "../../core/config/types.js";
import { evaluate } from "../../core/config/index.js";
import { INTENT_SCHEMA_VERSION, INTENT_VERSION } from "./intent_schema.js";
import { loadAuth } from "../auth/store.js";

type QueryKind =
  | "event"
  | "evidence"
  | "gate"
  | "evaluation"
  | "reliability"
  | "config"
  | "health";

function resolveRoot(): string {
  const root = String(process.env.CRYPTO_AGENT_ROOT || "").trim();
  if (root) return root;
  const cwd = process.cwd();
  if (cwd.includes("chat-gateway")) {
    return path.resolve(cwd, "..", "crypto_agent");
  }
  return cwd;
}

function resolveEventDir(): string {
  return String(process.env.EVENT_DIR || "").trim() || path.join(resolveRoot(), "data/event_v2");
}

function resolveMetricsDir(): string {
  return String(process.env.METRICS_DIR || "").trim() || path.join(resolveRoot(), "data/metrics");
}

function resolveConfigDir(): string {
  return String(process.env.CONFIG_DIR || "").trim() || path.join(resolveRoot(), "config");
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function parseQuery(text: string): { kind: QueryKind; arg: string } | null {
  const t = String(text || "").trim();
  if (!t) return null;
  const m = t.match(/^\/(event|evidence|gate|eval|evaluation|reliability|config|health)\b(.*)$/i);
  if (!m) return null;
  const kindRaw = m[1].toLowerCase();
  const arg = String(m[2] || "").trim();
  const kind = kindRaw === "eval" ? "evaluation" : (kindRaw as QueryKind);
  return { kind, arg };
}

function extractDate(arg: string): string | null {
  const match = arg.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (match) return match[1];
  const m2 = arg.match(/\bdate[:=]\s*(\d{4}-\d{2}-\d{2})\b/i);
  if (m2) return m2[1];
  return null;
}

async function readLastJsonl(pathStr: string): Promise<any | null> {
  if (!fs.existsSync(pathStr)) return null;
  const stream = fs.createReadStream(pathStr, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let last: any = null;
  for await (const line of rl) {
    const s = String(line || "").trim();
    if (!s) continue;
    try {
      last = JSON.parse(s);
    } catch {}
  }
  return last;
}

async function findByEventId(pathStr: string, eventId: string): Promise<any | null> {
  if (!fs.existsSync(pathStr)) return null;
  const stream = fs.createReadStream(pathStr, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const s = String(line || "").trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (obj && obj.event_id === eventId) {
        rl.close();
        return obj;
      }
    } catch {}
  }
  return null;
}

function resolveEventId(arg: string): string | null {
  const idMatch = arg.match(/evt_[A-Za-z0-9_-]+/i);
  if (idMatch) return idMatch[0];
  return null;
}

function formatJson(obj: any, limit = 6000): string {
  const raw = JSON.stringify(obj, null, 2);
  if (raw.length <= limit) return raw;
  return raw.slice(0, Math.max(0, limit - 20)) + "\n...(clipped)";
}

function loadYamlVersion(filePath: string): string {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const obj = YAML.parse(raw) as any;
    const v = String(obj?.version || "").trim();
    return v || "missing";
  } catch {
    return "missing";
  }
}

export async function handleQueryIfAny(params: {
  storageDir: string;
  config?: LoadedConfig;
  allowlistMode: "owner_only" | "auth";
  ownerChatId: string;
  ownerUserId: string;
  channel: "telegram" | "feishu";
  chatId: string;
  userId: string;
  isGroup: boolean;
  mentionsBot: boolean;
  text: string;
  send: (chatId: string, text: string) => Promise<void>;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
  adapterEntry?: boolean;
}): Promise<boolean> {
  const {
    storageDir,
    config,
    allowlistMode,
    ownerChatId,
    ownerUserId,
    channel,
    chatId,
    userId,
    isGroup,
    mentionsBot,
    text,
    send,
    requestId,
    requestIdBase,
    attempt,
    adapterEntry,
  } = params;

  const parsed = parseQuery(text);
  if (!parsed) return false;

  const authState = loadAuth(storageDir, ownerChatId, channel);
  const isOwnerChat = chatId === ownerChatId;
  const isOwnerUser = ownerUserId ? userId === ownerUserId : userId === ownerChatId;
  const allowed =
    allowlistMode === "owner_only"
      ? (isGroup ? isOwnerUser : isOwnerChat)
      : authState.allowed.includes(chatId) || isOwnerUser;

  const evalRes = evaluate(config, {
    channel,
    capability: "alerts.query",
    chat_id: chatId,
    chat_type: isGroup ? "group" : "private",
    user_id: userId,
    mention_bot: mentionsBot,
    has_reply: false,
  });
  const isAllowed = (config?.meta?.policyOk === true) ? evalRes.allowed : allowed;
  if (!isAllowed) {
    await send(chatId, evalRes.deny_message || rejectText("未授权操作"));
    appendLedger(storageDir, {
      ts_utc: new Date().toISOString(),
      channel,
      chat_id: chatId,
      user_id: userId,
      cmd: "alert_query_reject",
      request_id: requestId,
      request_id_base: requestIdBase,
      attempt,
      reason: "not_allowed",
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      adapter_entry: adapterEntry,
    });
    return true;
  }

  const date = extractDate(parsed.arg) || todayUtc();
  const eventDir = resolveEventDir();
  const metricsDir = resolveMetricsDir();
  const configDir = resolveConfigDir();

  let payload: any = null;
  const deny = async (message: string, code: string) => {
    await send(chatId, message);
    appendLedger(storageDir, {
      ts_utc: new Date().toISOString(),
      channel,
      chat_id: chatId,
      user_id: userId,
      cmd: `alert_query_${parsed.kind}`,
      request_id: requestId,
      request_id_base: requestIdBase,
      attempt,
      ok: false,
      error_code: code,
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      adapter_entry: adapterEntry,
    });
  };
  const ensureDir = (p: string) => fs.existsSync(p);
  if (parsed.kind === "event") {
    if (!ensureDir(eventDir)) {
      await deny("event_dir 不可用，请配置 CRYPTO_AGENT_ROOT/EVENT_DIR。", "missing_event_dir");
      return true;
    }
    const pathStr = path.join(eventDir, `event_envelope_${date}.jsonl`);
    const eventId = resolveEventId(parsed.arg);
    payload = eventId ? await findByEventId(pathStr, eventId) : await readLastJsonl(pathStr);
  } else if (parsed.kind === "evidence") {
    if (!ensureDir(eventDir)) {
      await deny("event_dir 不可用，请配置 CRYPTO_AGENT_ROOT/EVENT_DIR。", "missing_event_dir");
      return true;
    }
    const pathStr = path.join(eventDir, `evidence_pack_${date}.jsonl`);
    const eventId = resolveEventId(parsed.arg);
    payload = eventId ? await findByEventId(pathStr, eventId) : await readLastJsonl(pathStr);
  } else if (parsed.kind === "gate") {
    if (!ensureDir(eventDir)) {
      await deny("event_dir 不可用，请配置 CRYPTO_AGENT_ROOT/EVENT_DIR。", "missing_event_dir");
      return true;
    }
    const pathStr = path.join(eventDir, `gate_decision_${date}.jsonl`);
    const eventId = resolveEventId(parsed.arg);
    payload = eventId ? await findByEventId(pathStr, eventId) : await readLastJsonl(pathStr);
  } else if (parsed.kind === "evaluation") {
    if (!ensureDir(metricsDir)) {
      await deny("metrics_dir 不可用，请配置 CRYPTO_AGENT_ROOT/METRICS_DIR。", "missing_metrics_dir");
      return true;
    }
    const pathStr = path.join(metricsDir, `evaluation_result_${date}.jsonl`);
    const eventId = resolveEventId(parsed.arg);
    payload = eventId ? await findByEventId(pathStr, eventId) : await readLastJsonl(pathStr);
  } else if (parsed.kind === "reliability") {
    if (!ensureDir(metricsDir)) {
      await deny("metrics_dir 不可用，请配置 CRYPTO_AGENT_ROOT/METRICS_DIR。", "missing_metrics_dir");
      return true;
    }
    const pathStr = path.join(metricsDir, `reliability_${date}.jsonl`);
    payload = await readLastJsonl(pathStr);
  } else if (parsed.kind === "config") {
    if (!ensureDir(configDir)) {
      await deny("config_dir 不可用，请配置 CRYPTO_AGENT_ROOT/CONFIG_DIR。", "missing_config_dir");
      return true;
    }
    payload = {
      event_envelope_schema: loadYamlVersion(path.join(configDir, "event_envelope_schema.yaml")),
      evidence_pack_schema: loadYamlVersion(path.join(configDir, "evidence_pack_schema.yaml")),
      gate_decision_schema: loadYamlVersion(path.join(configDir, "gate_decision_schema.yaml")),
      evaluation_result_schema: loadYamlVersion(path.join(configDir, "evaluation_result_schema.yaml")),
      reliability_policy: loadYamlVersion(path.join(configDir, "reliability_policy.yaml")),
      explanation_schema: loadYamlVersion(path.join(configDir, "explanation_schema.yaml")),
      explanation_templates: loadYamlVersion(path.join(configDir, "explanation_templates.yaml")),
    };
  } else if (parsed.kind === "health") {
    payload = {
      event_dir: eventDir,
      metrics_dir: metricsDir,
      config_dir: configDir,
      date_utc: date,
    };
  }

  if (!payload) {
    await send(chatId, "未找到对应数据（请确认 event_id 或日期）。");
  } else {
    await send(chatId, formatJson(payload));
  }

  appendLedger(storageDir, {
    ts_utc: new Date().toISOString(),
    channel,
    chat_id: chatId,
    user_id: userId,
    cmd: `alert_query_${parsed.kind}`,
    request_id: requestId,
    request_id_base: requestIdBase,
    attempt,
    ok: Boolean(payload),
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    adapter_entry: adapterEntry,
  });
  return true;
}
