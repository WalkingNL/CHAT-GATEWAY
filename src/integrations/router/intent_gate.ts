import { evaluate } from "../../core/config/index.js";
import type { LoadedConfig } from "../../core/config/types.js";
import { loadAuth } from "../auth/store.js";
import { rejectText } from "../runtime/response_templates.js";

export type GateDecision =
  | { allowed: true }
  | { allowed: false; block: "ignore" | "reply" | "consume"; message?: string };

export function checkExplainGate(params: {
  storageDir: string;
  config: LoadedConfig | undefined;
  allowlistMode: "owner_only" | "auth";
  ownerChatId: string;
  ownerUserId: string;
  channel: "telegram" | "feishu";
  chatId: string;
  userId: string;
  isGroup: boolean;
  mentionsBot: boolean;
  hasReply: boolean;
}): GateDecision {
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
    hasReply,
  } = params;

  if (isGroup) {
    const res = evaluate(config, {
      channel,
      capability: "alerts.explain",
      chat_id: chatId,
      chat_type: "group",
      user_id: userId,
      mention_bot: mentionsBot,
      has_reply: hasReply,
    });
    if (res.require?.mention_bot_for_explain && !mentionsBot) {
      return { allowed: false, block: "ignore" };
    }
    if (res.require?.reply_required_for_explain && !hasReply) {
      return { allowed: false, block: "reply", message: "请回复一条告警/新闻消息再 @我。" };
    }
    if (!res.allowed) {
      return {
        allowed: false,
        block: "reply",
        message: res.deny_message || rejectText("未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。"),
      };
    }
    return { allowed: true };
  }

  const authState = loadAuth(storageDir, ownerChatId, channel);
  const resolvedOwnerUserId = String(ownerUserId || "");
  const isOwnerChat = chatId === ownerChatId;
  const isOwnerUser = resolvedOwnerUserId ? userId === resolvedOwnerUserId : false;
  const allowed =
    allowlistMode === "owner_only"
      ? (isGroup ? isOwnerUser : isOwnerChat)
      : authState.allowed.includes(chatId) || isOwnerUser;
  if (!allowed) {
    return { allowed: false, block: "consume" };
  }

  return { allowed: true };
}
