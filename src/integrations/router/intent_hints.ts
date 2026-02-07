import { isExplainRequest, wantsNewsSummary } from "./intent_registry.js";

export function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripFeedbackPrefix(rawText: string): { text: string; used: boolean } {
  const raw = String(rawText || "");
  const trimmed = raw.trim();
  if (!trimmed) return { text: "", used: false };
  const replaced = trimmed.replace(/^(\/feedback(?:@[A-Za-z0-9_]+)?|feedback|反馈)[:：]?\s*/i, "");
  if (replaced === trimmed) return { text: trimmed, used: false };
  return { text: replaced.trim(), used: true };
}

export function shouldAttemptResolve(params: {
  rawText: string;
  strippedText: string;
  isGroup: boolean;
  mentionsBot: boolean;
  replyToId: string;
  usedFeedbackPrefix: boolean;
}): boolean {
  const raw = String(params.rawText || "").trim();
  if (!raw) return false;
  const isCommand = raw.startsWith("/") && !params.usedFeedbackPrefix;
  if (isCommand) return false;
  if (params.isGroup) {
    if (!params.mentionsBot) return false;
  }
  return Boolean(params.strippedText);
}

export function buildIntentHints(params: {
  channel: string;
  text: string;
  isGroup: boolean;
  mentionsBot: boolean;
  replyToId: string;
  botUsername?: string;
}): {
  cleanedText: string;
  intentRawText: string;
  summaryRequested: boolean;
  explainRequested: boolean;
  resolveText: string;
  allowResolve: boolean;
  usedFeedbackPrefix: boolean;
} {
  const trimmedText = String(params.text || "").trim();
  const botUsername = params.botUsername ?? (params.channel === "telegram"
    ? String(process.env.TELEGRAM_BOT_USERNAME || "SoliaNLBot")
    : "");
  const mentionToken = botUsername
    ? (botUsername.startsWith("@") ? botUsername : `@${botUsername}`)
    : "";
  const mentionPattern = mentionToken ? new RegExp(escapeRegExp(mentionToken), "gi") : null;
  const cleanedText =
    params.channel === "telegram" && params.isGroup && params.mentionsBot && mentionPattern
      ? trimmedText.replace(mentionPattern, "").trim()
      : trimmedText;

  const intentRawText = cleanedText;
  const summaryRequested = wantsNewsSummary(intentRawText);
  const explainRequested = isExplainRequest(intentRawText);
  const feedbackStripped = stripFeedbackPrefix(intentRawText);
  const resolveText = feedbackStripped.text;
  const allowResolve = !explainRequested
    && !summaryRequested
    && shouldAttemptResolve({
      rawText: intentRawText,
      strippedText: resolveText,
      isGroup: params.isGroup,
      mentionsBot: params.mentionsBot,
      replyToId: params.replyToId,
      usedFeedbackPrefix: feedbackStripped.used,
    });

  return {
    cleanedText,
    intentRawText,
    summaryRequested,
    explainRequested,
    resolveText,
    allowResolve,
    usedFeedbackPrefix: feedbackStripped.used,
  };
}
