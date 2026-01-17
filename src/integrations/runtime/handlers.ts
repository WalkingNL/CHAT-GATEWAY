import { appendLedger } from "../audit/ledger.js";
import { detectChartIntents, renderChart } from "../channels/charts.js";
import { detectFeedback, FEEDBACK_REPLY, updatePushPolicyTargets } from "../channels/feedback.js";
import { loadAuth } from "../auth/store.js";
import { evaluate } from "../../core/config/index.js";
import type { LoadedConfig } from "../../core/config/types.js";

export async function handleFeedbackIfAny(params: {
  storageDir: string;
  channel: string;
  chatId: string;
  userId: string;
  text: string;
  send: (chatId: string, text: string) => Promise<void>;
}): Promise<boolean> {
  const { storageDir, channel, chatId, userId, text, send } = params;
  const hit = detectFeedback(text);
  if (!hit) return false;

  let update: ReturnType<typeof updatePushPolicyTargets> | null = null;
  let error: string | null = null;
  try {
    update = updatePushPolicyTargets(hit.kind, { updatedBy: `${channel}:${userId}` });
  } catch (e: any) {
    error = String(e?.message || e);
    console.error("[feedback][WARN] update failed:", error);
  }

  await send(chatId, FEEDBACK_REPLY);
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
  chatId: string;
  userId: string;
  text: string;
  isGroup: boolean;
  mentionsBot: boolean;
  replyText: string;
  sendTelegram: (chatId: string, imagePath: string, caption?: string) => Promise<void>;
  sendTelegramText: (chatId: string, text: string) => Promise<void>;
  sendFeishuImage?: (chatId: string, imagePath: string) => Promise<void>;
  sendFeishuText?: (chatId: string, text: string) => Promise<void>;
  feishuChatId?: string;
}): Promise<boolean> {
  const {
    storageDir,
    config,
    allowlistMode,
    ownerChatId,
    ownerUserId,
    chatId,
    userId,
    text,
    isGroup,
    mentionsBot,
    replyText,
    sendTelegram,
    sendTelegramText,
    sendFeishuImage,
    sendFeishuText,
    feishuChatId,
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

  const authState = loadAuth(storageDir, ownerChatId, "telegram");
  const isOwnerChat = chatId === ownerChatId;
  const isOwnerUser = ownerUserId ? userId === ownerUserId : userId === ownerChatId;
  const allowed =
    allowlistMode === "owner_only"
      ? (isGroup ? isOwnerUser : isOwnerChat)
      : authState.allowed.includes(chatId) || isOwnerUser;
  const policyOk = config?.meta?.policyOk === true;
  const chatType = isGroup ? "group" : "private";

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
      const rendered = renderChart(intent);
      await sendTelegram(chatId, rendered.outPath, rendered.caption);
      if (sendFeishuImage && sendFeishuText && feishuChatId) {
        await sendFeishuText(feishuChatId, rendered.caption);
        await sendFeishuImage(feishuChatId, rendered.outPath);
      }
    } catch (e: any) {
      await sendTelegramText(chatId, `图表生成失败：${String(e?.message || e)}`);
      return true;
    }
  }

  return true;
}
