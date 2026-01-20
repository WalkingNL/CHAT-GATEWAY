import fs from "node:fs";
import path from "node:path";
import { appendLedger } from "../audit/ledger.js";
import { detectChartIntents, renderChart } from "../channels/charts.js";
import {
  buildFeedbackReply,
  buildLevelOverrideReply,
  detectFeedback,
  detectLevelOverride,
  FEEDBACK_REPLY,
  updatePushPolicyMinPriority,
  updatePushPolicyTargets,
} from "../channels/feedback.js";
import { loadAuth } from "../auth/store.js";
import { evaluate } from "../../core/config/index.js";
import type { LoadedConfig } from "../../core/config/types.js";

function sanitizeRequestId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 200);
}

function buildChartRequestId(
  channel: string,
  messageId: string,
  chatId: string,
  intent: ReturnType<typeof detectChartIntents>[number],
) {
  const parts: string[] = [channel, chatId, messageId, intent.kind];
  return sanitizeRequestId(parts.join(":"));
}

function resolveProjectId(config?: LoadedConfig): string | null {
  const envId = String(process.env.GW_DEFAULT_PROJECT_ID || "").trim();
  if (envId) return envId;

  const policyAny = config?.policy as any;
  const policyId = typeof policyAny?.default_project_id === "string"
    ? policyAny.default_project_id.trim()
    : "";
  if (policyId) return policyId;

  const projects = config?.projects || {};
  for (const [id, proj] of Object.entries(projects)) {
    if (proj && (proj as any).enabled !== false) return id;
  }
  const ids = Object.keys(projects);
  return ids.length ? ids[0] : null;
}

export async function handleFeedbackIfAny(params: {
  storageDir: string;
  allowlistMode: "owner_only" | "auth";
  ownerChatId: string;
  ownerUserId: string;
  channel: string;
  chatId: string;
  userId: string;
  isGroup: boolean;
  text: string;
  send: (chatId: string, text: string) => Promise<void>;
}): Promise<boolean> {
  const { storageDir, channel, chatId, userId, text, send, allowlistMode, ownerChatId, ownerUserId, isGroup } = params;
  const levelIntent = detectLevelOverride(text);
  const hit = detectFeedback(text);
  if (!levelIntent && !hit) return false;

  const authState = loadAuth(storageDir, ownerChatId, channel);
  const isOwnerChat = chatId === ownerChatId;
  const isOwnerUser = ownerUserId ? userId === ownerUserId : userId === ownerChatId;
  const allowed =
    allowlistMode === "owner_only"
      ? (isGroup ? isOwnerUser : isOwnerChat)
      : authState.allowed.includes(chatId) || isOwnerUser;
  if (!allowed) {
    await send(chatId, "无权限。请联系管理员加入允许列表；群聊请用 /feedback 或 @bot 触发。");
    appendLedger(storageDir, {
      ts_utc: new Date().toISOString(),
      channel,
      chat_id: chatId,
      user_id: userId,
      kind: "alert_feedback_reject",
      feedback: hit.kind,
      raw: hit.normalizedText,
      reason: "not_allowed",
    });
    return true;
  }

  if (levelIntent) {
    if ("invalid" in levelIntent) {
      await send(chatId, "已收到反馈，但等级无效/超出范围（仅支持 LOW/MEDIUM/HIGH/CRITICAL），未做调整。");
      appendLedger(storageDir, {
        ts_utc: new Date().toISOString(),
        channel,
        chat_id: chatId,
        user_id: userId,
        kind: "alert_feedback_invalid",
        raw: levelIntent.normalizedText,
        reason: "invalid_level",
      });
      return true;
    }
    let update: ReturnType<typeof updatePushPolicyMinPriority> | null = null;
    let error: string | null = null;
    try {
      update = updatePushPolicyMinPriority(levelIntent.level, { updatedBy: `${channel}:${userId}` });
    } catch (e: any) {
      error = String(e?.message || e);
      console.error("[feedback][WARN] level override failed:", error);
    }

    let reply = FEEDBACK_REPLY;
    if (update) reply = buildLevelOverrideReply(levelIntent.level, update);
    if (error || !update) {
      reply = "已收到反馈，但当前未能更新策略，请稍后重试或联系管理员。";
    }
    await send(chatId, reply);

    if (update) {
      try {
        const statePath = path.join(storageDir, "feedback_state.json");
        const payload = {
          ts_utc: new Date().toISOString(),
          channel,
          chat_type: isGroup ? "group" : "private",
          chat_id: chatId,
          user_id: userId,
          kind: "set_level",
          normalized_text: levelIntent.normalizedText,
          updated: update.updated ?? false,
          policy_path: update.path,
          policy_version: update.policyVersion,
          min_priority_prev: update.prevMinPriority,
          min_priority_next: update.nextMinPriority,
          push_level_prev: update.prevPushLevel,
          push_level_next: update.nextPushLevel,
          target_prev: update.prevTarget,
          target_next: update.nextTarget,
          error: error || undefined,
        };
        const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
        fs.mkdirSync(storageDir, { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
        fs.renameSync(tmp, statePath);
      } catch {
        // ignore feedback state write errors
      }
    }

    appendLedger(storageDir, {
      ts_utc: new Date().toISOString(),
      channel,
      chat_id: chatId,
      user_id: userId,
      kind: "alert_feedback_level",
      feedback: levelIntent.level,
      raw: levelIntent.normalizedText,
      policy_path: update?.path,
      target_prev: update?.prevTarget,
      target_next: update?.nextTarget,
      min_priority_prev: update?.prevMinPriority,
      min_priority_next: update?.nextMinPriority,
      push_level_prev: update?.prevPushLevel,
      push_level_next: update?.nextPushLevel,
      policy_version: update?.policyVersion,
      updated: update?.updated,
      error: error || undefined,
    });
    return true;
  }

  let update: ReturnType<typeof updatePushPolicyTargets> | null = null;
  let error: string | null = null;
  try {
    update = updatePushPolicyTargets(hit.kind, { updatedBy: `${channel}:${userId}` });
  } catch (e: any) {
    error = String(e?.message || e);
    console.error("[feedback][WARN] update failed:", error);
  }

  let reply = FEEDBACK_REPLY;
  if (update) reply = buildFeedbackReply(hit.kind, update);
  if (error || !update) {
    reply = "已收到反馈，但当前未能更新策略，请稍后重试或联系管理员。";
  }
  await send(chatId, reply);

  try {
    const statePath = path.join(storageDir, "feedback_state.json");
    const payload = {
      ts_utc: new Date().toISOString(),
      channel,
      chat_type: isGroup ? "group" : "private",
      chat_id: chatId,
      user_id: userId,
      kind: hit.kind,
      normalized_text: hit.normalizedText,
      updated: update?.updated ?? false,
      cooldown_remaining_sec: update?.cooldownRemainingSec,
      policy_path: update?.path,
      policy_version: update?.policyVersion,
      min_priority_prev: update?.prevMinPriority,
      min_priority_next: update?.nextMinPriority,
      push_level_prev: update?.prevPushLevel,
      push_level_next: update?.nextPushLevel,
      target_prev: update?.prevTarget,
      target_next: update?.nextTarget,
      error: error || undefined,
    };
    const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmp, statePath);
  } catch {
    // ignore feedback state write errors
  }

  appendLedger(storageDir, {
    ts_utc: new Date().toISOString(),
    channel,
    chat_id: chatId,
    user_id: userId,
    kind: "alert_feedback",
    feedback: hit.kind,
    raw: hit.normalizedText,
    policy_path: update?.path,
    target_prev: update?.prevTarget,
    target_next: update?.nextTarget,
    min_priority_prev: update?.prevMinPriority,
    min_priority_next: update?.nextMinPriority,
    push_level_prev: update?.prevPushLevel,
    push_level_next: update?.nextPushLevel,
    policy_version: update?.policyVersion,
    updated: update?.updated,
    cooldown_remaining_sec: update?.cooldownRemainingSec,
    error: error || undefined,
  });

  return true;
}

export async function handleChartIfAny(params: {
  storageDir: string;
  config: LoadedConfig;
  allowlistMode: "owner_only" | "auth";
  ownerChatId: string;
  ownerUserId: string;
  channel: string;
  chatId: string;
  messageId: string;
  replyToId: string;
  userId: string;
  text: string;
  isGroup: boolean;
  mentionsBot: boolean;
  replyText: string;
  sendTelegramText: (chatId: string, text: string) => Promise<void>;
}): Promise<boolean> {
  const {
    storageDir,
    config,
    allowlistMode,
    ownerChatId,
    ownerUserId,
    channel,
    chatId,
    messageId,
    replyToId,
    userId,
    text,
    isGroup,
    mentionsBot,
    replyText,
    sendTelegramText,
  } = params;

  const trimmed = String(text || "").trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  const commandToken = "/chart";
  let chartQuery: string | null = null;
  let usedCommand = false;

  if (lower.startsWith(commandToken)) {
    chartQuery = trimmed.slice(commandToken.length).trim();
    usedCommand = true;
  } else if (mentionsBot && lower.includes(commandToken)) {
    const idx = lower.indexOf(commandToken);
    chartQuery = trimmed.slice(idx + commandToken.length).trim();
    usedCommand = true;
  } else if (!isGroup) {
    chartQuery = trimmed;
  } else {
    return false;
  }

  if (!chartQuery) {
    if (usedCommand) {
      await sendTelegramText(chatId, "Usage: /chart <symbol> <factor|daily activity> <time window>");
      return true;
    }
    return false;
  }

  const intents = detectChartIntents(chartQuery);
  if (!intents.length) {
    if (usedCommand) {
      await sendTelegramText(chatId, "未识别图表类型。示例：/chart BTC factor timeline 24h");
      return true;
    }
    return false;
  }

  const requestKey = messageId || replyToId;
  if (!requestKey) {
    await sendTelegramText(chatId, "该平台缺 messageId 且无回复 parent_id，请用回复触发/升级适配");
    appendLedger(storageDir, {
      ts_utc: new Date().toISOString(),
      channel,
      chat_id: chatId,
      user_id: userId,
      kind: "chart_reject",
      reason: "missing_message_id_and_parent_id",
      raw: trimmed,
    });
    return true;
  }

  const authState = loadAuth(storageDir, ownerChatId, "telegram");
  const isOwnerChat = chatId === ownerChatId;
  const isOwnerUser = ownerUserId ? userId === ownerUserId : userId === ownerChatId;
  const allowed =
    allowlistMode === "owner_only"
      ? (isGroup ? isOwnerUser : isOwnerChat)
      : authState.allowed.includes(chatId) || isOwnerUser;
  const policyOk = config?.meta?.policyOk === true;
  const chatType = isGroup ? "group" : "private";
  const projectId = resolveProjectId(config);

  if (!projectId) {
    await sendTelegramText(chatId, "未配置默认项目，无法生成图表");
    return true;
  }

  const checkAllowed = (capability: string) => {
    const res = evaluate(config, {
      channel: "telegram",
      capability,
      chat_id: chatId,
      chat_type: chatType,
      user_id: userId,
      mention_bot: mentionsBot,
      has_reply: Boolean(replyText),
    });
    if (!policyOk) return { allowed, res };
    if (res.allowed) return { allowed: true, res };
    if (res.require?.mention_bot_for_ops && !mentionsBot) {
      return { allowed: false, silent: true, res };
    }
    if ((res.reason === "not_allowed" || !res.reason) && allowed) {
      return { allowed: true, res };
    }
    return { allowed: false, res };
  };

  for (const intent of intents) {
    const capability =
      intent.kind === "factor_timeline"
        ? "ops.chart.factor_timeline"
        : "ops.chart.daily_activity";
    const gate = checkAllowed(capability);
    if (!gate.allowed) {
      if (!gate.silent) {
        await sendTelegramText(
          chatId,
          gate.res?.deny_message || "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放。",
        );
      }
      return true;
    }

    if (intent.kind === "factor_timeline" && !intent.symbol) {
      await sendTelegramText(chatId, "请指定币种（BTC/ETH/BTCUSDT）");
      return true;
    }

    try {
      const reqId = buildChartRequestId(channel || "telegram", requestKey, chatId, intent);
      const rendered = await renderChart(intent, { projectId, requestId: reqId });
      if (!rendered.ok) {
        const trace = rendered.traceId ? ` trace_id=${rendered.traceId}` : "";
        throw new Error(`${rendered.error || "render_failed"}${trace}`.trim());
      }
      await sendTelegramText(chatId, "已请求生成图表，稍后发送");
    } catch (e: any) {
      await sendTelegramText(chatId, `图表生成失败：${String(e?.message || e)}`);
      return true;
    }
  }

  return true;
}
