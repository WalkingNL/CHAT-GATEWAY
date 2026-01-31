import { handleAdapterIntentIfAny, handleMessage } from "../router/router.js";
import { handleChartIfAny, handleDashboardIntentIfAny, handleFeedbackIfAny } from "./handlers.js";
import type { IntegrationContext } from "./context.js";
import type { MessageEvent } from "./message_event.js";

type Senders = {
  sendText: (chatId: string, text: string) => Promise<void>;
  sendPhoto?: (chatId: string, imagePath: string, caption?: string) => Promise<void>;
  sendFeishuText?: (chatId: string, text: string) => Promise<void>;
  sendFeishuImage?: (chatId: string, imagePath: string) => Promise<void>;
  feishuChatId?: string;
};

export async function dispatchMessageEvent(ctx: IntegrationContext, event: MessageEvent, senders: Senders) {
  const { cfg, loaded, storageDir, limiter } = ctx;

  const tcfg = cfg.channels?.telegram ?? {};
  const fcfg = cfg.channels?.feishu ?? {};

  const allowlistModeTelegram = (tcfg.allowlist_mode ?? "auth") as "owner_only" | "auth";
  const allowlistModeFeishu = (fcfg.allowlist_mode ?? "auth") as "owner_only" | "auth";

  const ownerTelegramChatId = String(cfg.gateway?.owner?.telegram_chat_id ?? "");
  const ownerTelegramUserId = String(process.env.OWNER_TELEGRAM_USER_ID || "");
  const ownerFeishuChatId = String(cfg.gateway?.owner?.feishu_chat_id ?? "");
  const ownerFeishuUserId = String(process.env.OWNER_FEISHU_USER_ID || "");

  const channel = event.channel;
  const allowlistMode = channel === "telegram" ? allowlistModeTelegram : allowlistModeFeishu;
  const ownerChatId = channel === "telegram" ? ownerTelegramChatId : ownerFeishuChatId;
  const ownerUserId = channel === "telegram" ? ownerTelegramUserId : ownerFeishuUserId;

  if (await handleFeedbackIfAny({
    storageDir,
    config: loaded,
    allowlistMode,
    ownerChatId,
    ownerUserId,
    channel,
    chatId: event.chatId,
    userId: event.userId,
    isGroup: event.isGroup,
    text: event.text,
    send: senders.sendText,
  })) {
    return;
  }

  if (await handleAdapterIntentIfAny({
    storageDir,
    config: loaded,
    allowlistMode,
    ownerChatId,
    ownerUserId,
    channel: event.channel,
    chatId: event.chatId,
    messageId: event.messageId,
    replyToId: event.replyToId,
    userId: event.userId,
    text: event.text,
    isGroup: event.isGroup,
    mentionsBot: event.mentionsBot,
    replyText: event.replyText,
    send: senders.sendText,
  })) {
    return;
  }

  if (await handleDashboardIntentIfAny({
    storageDir,
    config: loaded,
    allowlistMode,
    ownerChatId,
    ownerUserId,
    channel: event.channel,
    chatId: event.chatId,
    messageId: event.messageId,
    replyToId: event.replyToId,
    userId: event.userId,
    text: event.text,
    isGroup: event.isGroup,
    mentionsBot: event.mentionsBot,
    replyText: event.replyText,
    sendText: senders.sendText,
  })) {
    return;
  }

  if (channel === "telegram") {
    if (await handleChartIfAny({
      storageDir,
      config: loaded,
      allowlistMode: allowlistModeTelegram,
      ownerChatId: ownerTelegramChatId,
      ownerUserId: ownerTelegramUserId,
      channel: event.channel,
      chatId: event.chatId,
      messageId: event.messageId,
      replyToId: event.replyToId,
      userId: event.userId,
      text: event.text,
      isGroup: event.isGroup,
      mentionsBot: event.mentionsBot,
      replyText: event.replyText,
      sendTelegramText: senders.sendText,
    })) {
      return;
    }
  }

  await handleMessage({
    storageDir,
    channel,
    ownerChatId,
    ownerUserId,
    allowlistMode,
    config: loaded,
    limiter,
    chatId: event.chatId,
    userId: event.userId,
    messageId: event.messageId,
    replyToId: event.replyToId,
    text: event.text,
    replyText: event.replyText,
    isGroup: event.isGroup,
    mentionsBot: event.mentionsBot,
    send: senders.sendText,
  });
}
