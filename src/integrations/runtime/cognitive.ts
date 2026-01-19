import { appendLedger } from "../audit/ledger.js";
import { loadAuth } from "../auth/store.js";
import type { LoadedConfig } from "../../core/config/types.js";
import {
  CognitiveStore,
  buildIssueId,
  hashText,
  normalizeText,
  type CognitiveItem,
  type CognitiveStatus,
  type CognitiveType,
  type CognitiveSource,
} from "../../core/cognitive_store.js";
import { submitTask } from "../../core/internal_client.js";

const EXPLICIT_INTENTS = [
  "记一下",
  "记录",
  "备忘",
  "加入问题账本",
  "加入认知账本",
  "加入账本",
  "追踪",
];

const PROBLEM_TRIGGERS = ["为什么", "怎么回事", "有问题", "不对", "失败", "报错", "无法", "缺失"];

const STATUS_MAP: Array<{ status: CognitiveStatus; terms: string[] }> = [
  { status: "DONE", terms: ["done", "完成", "已解决", "解决", "关闭"] },
  { status: "DISMISSED", terms: ["dismiss", "忽略", "不处理", "取消", "不用", "废弃"] },
  { status: "IN_PROGRESS", terms: ["in progress", "in_progress", "inprogress", "进行中", "处理中", "在做"] },
  { status: "BLOCKED", terms: ["blocked", "阻塞", "卡住"] },
  { status: "OPEN", terms: ["open", "打开", "未解决", "待处理"] },
];

const MIN_PROBLEM_LEN = 12;
const DEFAULT_REMIND_HOURS = 72;
const PENDING_TTL_MS = 10 * 60 * 1000;

function nowUtc(): string {
  return new Date().toISOString();
}

function isCommand(text: string): boolean {
  const t = String(text || "").trim();
  return t.startsWith("/");
}

function containsAny(text: string, terms: string[]): boolean {
  const t = String(text || "");
  return terms.some(term => t.includes(term));
}

function normalizeForMatch(text: string): string {
  return normalizeText(text).toLowerCase();
}

function detectExplicitIntent(text: string): boolean {
  const t = normalizeForMatch(text);
  return containsAny(t, EXPLICIT_INTENTS.map(s => s.toLowerCase()));
}

function detectProblemTone(text: string): boolean {
  const normalized = normalizeText(text);
  if (normalized.length < MIN_PROBLEM_LEN) return false;
  return containsAny(normalized, PROBLEM_TRIGGERS);
}

function parseReminderOffsetMs(text: string): number | null {
  const t = normalizeText(text);
  const rules: Array<{ re: RegExp; mult: number }> = [
    { re: /(\d+)\s*(小时|h|hr|hours?)/i, mult: 60 * 60 * 1000 },
    { re: /(\d+)\s*(天|日|d|days?)/i, mult: 24 * 60 * 60 * 1000 },
    { re: /(\d+)\s*(周|星期|weeks?|w)/i, mult: 7 * 24 * 60 * 60 * 1000 },
  ];
  for (const rule of rules) {
    const m = t.match(rule.re);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    return n * rule.mult;
  }
  return null;
}

function computeRemindAt(text: string): string {
  const offset = parseReminderOffsetMs(text);
  const base = offset != null ? offset : DEFAULT_REMIND_HOURS * 60 * 60 * 1000;
  return new Date(Date.now() + base).toISOString();
}

function clip(text: string, n: number): string {
  const t = String(text || "");
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function classifyByRules(text: string): { action: "record" | "ignore" | "unknown"; confidence: number; reason: string } {
  if (detectExplicitIntent(text)) {
    return { action: "record", confidence: 0.9, reason: "explicit_intent" };
  }
  if (detectProblemTone(text)) {
    return { action: "record", confidence: 0.7, reason: "problem_tone" };
  }
  return { action: "unknown", confidence: 0.5, reason: "no_rule_match" };
}

function extractFirstJsonObject(text: string): string | null {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

async function classifyWithLlm(params: {
  channel: string;
  chatType: string;
  text: string;
  taskIdSeed: string;
}): Promise<{ action: "record" | "ignore" | "ask_clarify"; confidence: number; reason: string } | null> {
  if (!process.env.CHAT_GATEWAY_TOKEN) return null;
  if (String(process.env.COGNITIVE_INTENT_LLM || "1") === "0") return null;

  const prompt =
    "You are a strict intent classifier for a Cognitive Ledger.\n" +
    "Return JSON only: {\"action\":\"record|ignore|ask_clarify\",\"confidence\":0-1,\"reason\":\"...\"}.\n" +
    "Record only if the text is a question/issue/observation/idea/task worth tracking.\n" +
    "Ignore casual chat/acknowledgements.\n\n" +
    `Channel: ${params.channel}\n` +
    `ChatType: ${params.chatType}\n` +
    `Text: ${params.text}\n`;

  try {
    const res = await submitTask({
      task_id: `cognitive_intent:${params.taskIdSeed}`,
      stage: "analyze",
      prompt,
    });
    const summary = String(res?.summary || "");
    const raw = extractFirstJsonObject(summary) || summary;
    const obj = JSON.parse(raw);
    const action = String(obj?.action || "").toLowerCase();
    const conf = Number(obj?.confidence);
    const reason = String(obj?.reason || "llm");
    if (action !== "record" && action !== "ignore" && action !== "ask_clarify") return null;
    const confidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5;
    return { action, confidence, reason };
  } catch (e) {
    console.warn("[cognitive][WARN] llm classify failed:", String((e as any)?.message || e));
    return null;
  }
}

function parseConfirm(text: string): "record" | "ignore" | null {
  const t = normalizeText(text);
  if (t === "记" || t === "记录" || t === "好" || t === "是") return "record";
  if (t === "不记" || t === "不记录" || t === "不要" || t === "否") return "ignore";
  return null;
}

function findCognitiveId(text: string): string | null {
  const idMatch = text.match(/\bC-\d{8}-\d{3}\b/i);
  return idMatch ? idMatch[0] : null;
}

function parseStatusUpdate(text: string): { id: string; status: CognitiveStatus } | null {
  const id = findCognitiveId(text);
  if (!id) return null;
  const lower = normalizeForMatch(text);
  for (const item of STATUS_MAP) {
    if (item.terms.some(term => lower.includes(term))) {
      return { id, status: item.status };
    }
  }
  return null;
}

function hasUpdateVerb(text: string): boolean {
  const t = normalizeForMatch(text);
  return ["更新", "状态", "改为", "设为", "标记", "修改"].some(word => t.includes(word));
}

function resolveOwnerMatch(userId: string, ownerUserId: string, ownerChatId: string): boolean {
  if (ownerUserId) return userId === ownerUserId;
  return userId === ownerChatId;
}

function isAllowed(params: {
  storageDir: string;
  channel: string;
  allowlistMode: "owner_only" | "auth";
  ownerChatId: string;
  ownerUserId: string;
  chatId: string;
  userId: string;
}): boolean {
  const isOwner = resolveOwnerMatch(params.userId, params.ownerUserId, params.ownerChatId);
  if (params.allowlistMode === "owner_only") return isOwner || params.chatId === params.ownerChatId;
  const auth = loadAuth(params.storageDir, params.ownerChatId, params.channel);
  return auth.allowed.includes(params.chatId) || isOwner || params.chatId === params.ownerChatId;
}

export async function handleCognitiveStatusUpdate(params: {
  storageDir: string;
  config: LoadedConfig;
  allowlistMode: "owner_only" | "auth";
  ownerChatId: string;
  ownerUserId: string;
  channel: "telegram" | "feishu";
  chatId: string;
  userId: string;
  text: string;
  isGroup: boolean;
  mentionsBot: boolean;
  send: (chatId: string, text: string) => Promise<void>;
}): Promise<boolean> {
  const { storageDir, allowlistMode, ownerChatId, ownerUserId, channel, chatId, userId, text, isGroup, mentionsBot, send } =
    params;
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (isCommand(normalized)) return false;
  if (isGroup && !mentionsBot) return false;
  if (!isAllowed({ storageDir, channel, allowlistMode, ownerChatId, ownerUserId, chatId, userId })) return false;

  const statusUpdate = parseStatusUpdate(normalized);
  if (!statusUpdate) return false;

  const store = new CognitiveStore(storageDir);
  const updated = await store.updateStatus(statusUpdate.id, statusUpdate.status, `${channel}:${userId}`);
  if (!updated) {
    await send(chatId, `未找到条目：${statusUpdate.id}`);
    return true;
  }
  await send(chatId, `已更新 ${updated.short_id} → ${updated.status}`);
  appendLedger(storageDir, {
    ts_utc: nowUtc(),
    channel,
    chat_id: chatId,
    user_id: userId,
    kind: "cognitive_status_update",
    issue_id: updated.issue_id,
    short_id: updated.short_id,
    status: updated.status,
  });
  return true;
}

export async function handleCognitiveIfAny(params: {
  storageDir: string;
  config: LoadedConfig;
  allowlistMode: "owner_only" | "auth";
  ownerChatId: string;
  ownerUserId: string;
  channel: "telegram" | "feishu";
  chatId: string;
  userId: string;
  messageId: string;
  replyToId: string;
  replyText: string;
  text: string;
  isGroup: boolean;
  mentionsBot: boolean;
  send: (chatId: string, text: string) => Promise<void>;
}): Promise<boolean> {
  const {
    storageDir,
    allowlistMode,
    ownerChatId,
    ownerUserId,
    channel,
    chatId,
    userId,
    messageId,
    replyToId,
    replyText,
    text,
    isGroup,
    mentionsBot,
    send,
  } = params;

  const rawText = String(text || "").trim();
  const normalized = normalizeText(rawText);
  const replyRaw = String(replyText || "").trim();
  const replyNormalized = normalizeText(replyRaw);
  if (!normalized) return false;
  if (isCommand(normalized)) return false;
  if (isGroup && !mentionsBot) return false;
  if (!isAllowed({ storageDir, channel, allowlistMode, ownerChatId, ownerUserId, chatId, userId })) return false;

  const store = new CognitiveStore(storageDir);
  const pendingKey = `${channel}:${chatId}:${userId}`;
  const confirm = parseConfirm(normalized);
  if (confirm) {
    const pending = await store.getPending(pendingKey);
    if (!pending) return false;
    if (confirm === "ignore") {
      await store.clearPending(pendingKey);
      await send(chatId, "已忽略");
      return true;
    }
    const item: Omit<CognitiveItem, "short_id"> = {
      issue_id: pending.issue_id,
      type: pending.type,
      raw_text: pending.raw_text,
      normalized_text: pending.normalized_text,
      dedup_key: pending.dedup_key,
      source: pending.source,
      status: "OPEN",
      created_at_utc: pending.created_at_utc,
      next_remind_at_utc: pending.next_remind_at_utc,
    };
    const created = await store.createItem(item);
    await store.clearPending(pendingKey);
    await send(chatId, `已记录：${created.short_id}`);
    return true;
  }

  const idOnly = findCognitiveId(normalized);
  if (idOnly && hasUpdateVerb(normalized) && !parseStatusUpdate(normalized)) {
    await send(
      chatId,
      `请指定状态，例如：${idOnly} DONE / IN_PROGRESS / BLOCKED / DISMISSED`,
    );
    return true;
  }

  const ruleDecision = classifyByRules(normalized);
  let decision: { action: "record" | "ignore" | "ask_clarify"; confidence: number; reason: string } | null = null;

  const stripIntentPrefix = (textValue: string): { matched: boolean; rest: string } => {
    const t = normalizeText(textValue);
    const lower = t.toLowerCase();
    for (const term of EXPLICIT_INTENTS) {
      const tl = term.toLowerCase();
      if (lower.startsWith(tl)) {
        let rest = t.slice(term.length).trim();
        rest = rest.replace(/^[:：\-—]+/, "").trim();
        return { matched: true, rest };
      }
    }
    return { matched: false, rest: "" };
  };

  const intentStrip = stripIntentPrefix(normalized);

  if (ruleDecision.action === "record") {
    decision = { ...ruleDecision, action: "record" };
  } else if (normalized.length < MIN_PROBLEM_LEN) {
    decision = { action: "ignore", confidence: 0.3, reason: "too_short" };
  } else {
    const llm = await classifyWithLlm({
      channel,
      chatType: isGroup ? "group" : "private",
      text: normalized,
      taskIdSeed: hashText(`${channel}:${chatId}:${messageId || replyToId}:${normalized}`),
    });
    decision = llm || { action: "ignore", confidence: 0.3, reason: "no_llm" };
  }

  const shouldAsk = decision.action === "ask_clarify" || (decision.confidence >= 0.4 && decision.confidence < 0.6);
  const shouldRecord = decision.action === "record" && decision.confidence >= 0.6;

  if (!shouldAsk && !shouldRecord) return false;

  let targetRawText = rawText;
  let targetNormalized = normalized;
  let useReplyId = false;

  if (intentStrip.matched) {
    if (intentStrip.rest) {
      targetRawText = intentStrip.rest;
      targetNormalized = normalizeText(intentStrip.rest);
    } else if (replyNormalized) {
      targetRawText = replyRaw;
      targetNormalized = replyNormalized;
      useReplyId = Boolean(replyToId);
    } else {
      await send(chatId, "请直接描述问题内容，或回复要记录的消息再说“记录这个问题”。");
      return true;
    }
  }

  const issueId = buildIssueId(
    channel,
    chatId,
    useReplyId ? "" : messageId,
    replyToId,
  );
  if (!issueId) {
    await send(chatId, "该平台缺 messageId 且无回复 parent_id，请用回复触发/升级适配");
    appendLedger(storageDir, {
      ts_utc: nowUtc(),
      channel,
      chat_id: chatId,
      user_id: userId,
      kind: "cognitive_reject",
      reason: "missing_message_id_and_parent_id",
      raw: normalized,
    });
    return true;
  }

  const source: CognitiveSource = {
    channel,
    chat_type: isGroup ? "group" : "private",
    chat_id: chatId,
    user_id: userId,
    message_id: messageId || undefined,
    reply_to_id: replyToId || undefined,
    mentions_bot: mentionsBot,
  };
  const createdAt = nowUtc();
  const itemType: CognitiveType = "question";
  const itemBase = {
    issue_id: issueId,
    type: itemType,
    raw_text: targetRawText,
    normalized_text: targetNormalized,
    dedup_key: hashText(targetNormalized),
    source,
    status: "OPEN" as CognitiveStatus,
    created_at_utc: createdAt,
    next_remind_at_utc: computeRemindAt(targetNormalized),
  };

  if (shouldAsk) {
    await store.setPending({
      key: pendingKey,
      issue_id: issueId,
      created_at_utc: createdAt,
      expires_at_utc: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
      raw_text: itemBase.raw_text,
      normalized_text: itemBase.normalized_text,
      dedup_key: itemBase.dedup_key,
      type: itemBase.type,
      source: itemBase.source,
      next_remind_at_utc: itemBase.next_remind_at_utc,
    });
    await send(chatId, "要把这条记到认知账本吗？回复：记 / 不记");
    appendLedger(storageDir, {
      ts_utc: nowUtc(),
      channel,
      chat_id: chatId,
      user_id: userId,
      kind: "cognitive_pending",
      issue_id: issueId,
      reason: decision.reason,
    });
    return true;
  }

  if (!shouldRecord) return false;

  const created = await store.createItem(itemBase);
  await send(chatId, `已记录：${created.short_id}（${clip(created.raw_text, 40)}）`);
  appendLedger(storageDir, {
    ts_utc: nowUtc(),
    channel,
    chat_id: chatId,
    user_id: userId,
    kind: "cognitive_recorded",
    issue_id: created.issue_id,
    short_id: created.short_id,
    status: created.status,
  });
  return true;
}

export function startCognitiveReminderLoop(params: {
  storageDir: string;
  senders: {
    telegram?: { sendText: (chatId: string, text: string) => Promise<void> };
    feishu?: { sendText: (chatId: string, text: string) => Promise<void> };
  };
}) {
  const intervalMs = Number(process.env.COGNITIVE_REMINDER_INTERVAL_MS || 60000);
  const store = new CognitiveStore(params.storageDir);
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const due = store.listDueReminders(Date.now());
      for (const item of due) {
        const send =
          item.source.channel === "feishu"
            ? params.senders.feishu?.sendText
            : params.senders.telegram?.sendText;
        if (!send) {
          console.warn("[cognitive][WARN] reminder sender missing:", item.source.channel);
          continue;
        }
        const msg =
          `提醒：${item.short_id} 需要确认是否继续关注\n` +
          `内容：${clip(item.raw_text, 120)}\n` +
          `回复示例：${item.short_id} DONE / IN_PROGRESS / BLOCKED / DISMISSED`;
        try {
          await send(item.source.chat_id, msg);
          await store.markReminded(item.issue_id, "reminder_sent");
        } catch (e: any) {
          console.warn("[cognitive][WARN] reminder send failed:", String(e?.message || e));
        }
      }
    } finally {
      running = false;
    }
  };

  setInterval(tick, Number.isFinite(intervalMs) && intervalMs > 5000 ? intervalMs : 60000);
}
