import { rejectText } from "../runtime/response_templates.js";
import { isIntentEnabled } from "../runtime/capabilities.js";

export type IntentMessages = {
  missingReplyGroup?: string;
  missingReplyPrivate?: string;
  missingReplyResolve?: string;
  unsupported?: string;
  missingProject?: string;
  expired?: string;
};

export type IntentMeta = {
  name: string;
  enabledKey?: string;
  disabledMessage?: string;
  allowGroup?: boolean;
  requiresAuth?: boolean;
  groupDenyAction?: "ignore" | "reject";
  denyMessage?: string;
  groupDenyMessage?: string;
  gateKind?: "explain";
  messages?: IntentMessages;
};

export const INTENT_REGISTRY: Record<string, IntentMeta> = {
  alert_strategy: {
    name: "alert_strategy",
    enabledKey: "alert_strategy",
    denyMessage: "未授权操作",
  },
  alert_query: {
    name: "alert_query",
    enabledKey: "alert_query",
    denyMessage: "未授权操作",
  },
  alert_explain: {
    name: "alert_explain",
    enabledKey: "alert_explain",
    gateKind: "explain",
    messages: {
      missingReplyGroup: "请回复一条告警/新闻消息再 @我。",
      missingReplyPrivate: "请先回复一条告警/新闻消息，然后发一句话（如：解释一下）。",
      expired: "请求已过期，请重新发起解释。",
    },
  },
  news_summary: {
    name: "news_summary",
    enabledKey: "news_summary",
    disabledMessage: "未开放新闻摘要能力。",
    gateKind: "explain",
    messages: {
      missingReplyGroup: "请回复一条新闻告警再发送摘要请求。",
      missingReplyPrivate: "请先回复一条告警/新闻消息，然后发一句话（如：解释一下 / 摘要 200）。",
      missingReplyResolve: "请先回复一条告警/新闻消息，然后发一句话（如：摘要 200）。",
      unsupported: "当前仅支持新闻摘要，请回复新闻告警再发“摘要 200”。",
      missingProject: "未配置默认项目，无法生成摘要。",
      expired: "请求已过期，请重新发起摘要。",
    },
  },
  data_feeds_status: {
    name: "data_feeds_status",
    enabledKey: "data_feeds_status",
    disabledMessage: "未开放数据源查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
    denyMessage: "未授权操作",
  },
  data_feeds_asset_status: {
    name: "data_feeds_asset_status",
    enabledKey: "data_feeds_asset_status",
    disabledMessage: "未开放数据源查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
    denyMessage: "未授权操作",
  },
  data_feeds_source_status: {
    name: "data_feeds_source_status",
    enabledKey: "data_feeds_source_status",
    disabledMessage: "未开放数据源查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
    denyMessage: "未授权操作",
  },
  data_feeds_hotspots: {
    name: "data_feeds_hotspots",
    enabledKey: "data_feeds_hotspots",
    disabledMessage: "未开放数据源查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
    denyMessage: "未授权操作",
  },
  data_feeds_ops_summary: {
    name: "data_feeds_ops_summary",
    enabledKey: "data_feeds_ops_summary",
    disabledMessage: "未开放数据源查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
    denyMessage: "未授权操作",
  },
  news_hot: {
    name: "news_hot",
    enabledKey: "news_hot",
    disabledMessage: "未开放新闻查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
    denyMessage: "未授权操作",
  },
  news_refresh: {
    name: "news_refresh",
    enabledKey: "news_refresh",
    disabledMessage: "未开放新闻查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
    denyMessage: "未授权操作",
  },
};

export const RESOLVE_MESSAGES = {
  clarifyUnknown: "我没有理解你的意图，请用一句话明确你要做的事。",
  resolveFailed: "当前解析失败，请稍后重试。",
  missingProject: "未配置默认项目，无法解析请求。",
  missingMessageId: "请求缺少 messageId/parent_id，无法解析。",
};

export const COMMAND_MESSAGES = {
  authDenied: "permission denied",
  feedsAssetMissing: "请指定资产（例如：ETHUSDT）。",
  feedsSourceMissing: "请指定 feed_id（例如：ohlcv_1m）。",
  feedsAssetUsage: "Usage: /feeds asset <SYMBOL>",
  feedsSourceUsage: "Usage: /feeds source <feed_id>",
  analyzeUsage: "Usage: /analyze <incident description>",
  suggestUsage: "Usage: /suggest <incident description>",
  signalsUsage: (maxWindow: number) => `Usage: /signals [N]m|[N]h (default 60m, max ${maxWindow}m)`,
  signalsTooLarge: (maxWindow: number) => `Window too large. Max ${maxWindow}m.`,
};

export const ACCESS_MESSAGES = {
  ownerOnlyExplain: "未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。",
  ownerOnlyExplainWithEmoji: "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。",
};

export const INTERACTION_MESSAGES = {
  quickHelp: "用法：回复一条告警发“解释一下”；回复新闻发“摘要 200”。",
  explainFeedbackMissing: "没有可反馈的解释。",
  explainFeedbackRecorded: "已记录反馈。",
  unknownCommand: "unknown command. /help",
  cognitiveConfirmPrompt: "请回复：记 / 不记",
  cognitiveStatusPrompt: "请补充记录编号与状态（例如：C-20260130-001 DONE）",
  chartTelegramOnly: "当前仅支持 Telegram 图表导出。",
};

export function getIntentMeta(name?: string | null): IntentMeta | null {
  if (!name) return null;
  return INTENT_REGISTRY[name] || null;
}

function getIntentMessage(intent: string, key: keyof IntentMessages): string | undefined {
  const meta = getIntentMeta(intent);
  return meta?.messages?.[key];
}

export function resolveIntentMessage(intent: string, key: keyof IntentMessages, fallback: string): string {
  return getIntentMessage(intent, key) || fallback;
}

export function resolveIntentDisabledMessage(intent: string, fallback: string): string {
  const meta = getIntentMeta(intent);
  return meta?.disabledMessage || fallback;
}

export function resolveGroupDenyAction(intent?: string | null): "allow" | "ignore" | "reject" {
  const meta = getIntentMeta(intent);
  if (!meta || meta.allowGroup !== false) return "allow";
  return meta.groupDenyAction || "ignore";
}

export function isIntentEnabledByName(name: string): boolean {
  const meta = getIntentMeta(name);
  const key = meta?.enabledKey || name;
  return isIntentEnabled(key);
}

export async function ensureIntentEnabledForCommand(
  send: (chatId: string, text: string) => Promise<void>,
  chatId: string,
  intent: string,
  fallback: string,
): Promise<boolean> {
  if (isIntentEnabledByName(intent)) return true;
  await send(chatId, rejectText(resolveIntentDisabledMessage(intent, fallback)));
  return false;
}
