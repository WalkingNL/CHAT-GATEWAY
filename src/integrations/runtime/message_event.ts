import type { TelegramMsg } from "../channels/telegramPolling.js";
import type { FeishuMsg } from "../channels/feishuWebhook.js";

export type MessageEvent = {
  channel: "telegram" | "feishu";
  chatId: string;
  chatType: string;
  userId: string;
  text: string;
  replyText: string;
  isGroup: boolean;
  mentionsBot: boolean;
};

export function fromTelegram(msg: TelegramMsg): MessageEvent {
  return {
    channel: "telegram",
    chatId: msg.chatId,
    chatType: msg.chatType || (msg.isGroup ? "group" : "private"),
    userId: msg.userId,
    text: msg.text,
    replyText: msg.replyText,
    isGroup: msg.isGroup,
    mentionsBot: msg.mentionsBot,
  };
}

export function fromFeishu(msg: FeishuMsg): MessageEvent {
  return {
    channel: "feishu",
    chatId: msg.chatId,
    chatType: msg.chatType || (msg.isGroup ? "group" : "private"),
    userId: msg.userId,
    text: msg.text,
    replyText: msg.replyText,
    isGroup: msg.isGroup,
    mentionsBot: msg.mentionsBot,
  };
}
