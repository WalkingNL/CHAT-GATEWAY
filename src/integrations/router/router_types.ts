import type { LoadedConfig } from "../../core/config/types.js";
import type { AdapterResultProbe } from "../runtime/handlers.js";

export type SendFn = (chatId: string, text: string) => Promise<void>;

export type AdapterContext = {
  storageDir: string;
  config: LoadedConfig;
  allowlistMode: "owner_only" | "auth";
  ownerChatId: string;
  ownerUserId: string;
  channel: "telegram" | "feishu";
  chatId: string;
  messageId: string;
  replyToId: string;
  userId: string;
  text: string;
  replyText: string;
  isGroup: boolean;
  mentionsBot: boolean;
  send: SendFn;
  reportResult?: (result: AdapterResultProbe) => void;
  trimmedText: string;
  trimmedReplyText: string;
  cleanedText: string;
  intentRawText: string;
  summaryRequested: boolean;
  explainRequested: boolean;
  resolveText: string;
  allowResolve: boolean;
  explicitRetry: boolean;
  isPrivate: boolean;
  projectId: string | null;
  defaultWindowSpecId?: string;
};
