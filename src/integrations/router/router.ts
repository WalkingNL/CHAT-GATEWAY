import { parseCommand } from "./commands.js";
import { buildIntentHints, escapeRegExp } from "./intent_hints.js";
import { runPipeline, type MatchResult, type PipelineStep } from "./intent_pipeline.js";
import type { RateLimiter } from "../../core/rateLimit/limiter.js";
import { appendLedger } from "../audit/ledger.js";
import { loadAuth } from "../auth/store.js";
import type { LoadedConfig } from "../../core/config/types.js";
import { resolveDefaultWindowSpecId } from "../runtime/intent_router.js";
import { parseDashboardIntent } from "../runtime/intent_schema.js";
import { dispatchDashboardExport } from "../runtime/handlers.js";
import { isIntentEnabled } from "../runtime/capabilities.js";
import { writeExplainFeedback } from "../audit/trace_writer.js";
import { getLastExplainTrace, setLastAlert } from "./state_cache.js";
import { handleStrategyIfAny } from "../runtime/strategy.js";
import { handleQueryIfAny } from "../runtime/query.js";
import { ACCESS_MESSAGES, INTERACTION_MESSAGES, INTENT_REGISTRY, isIntentEnabledByName, type IntentMeta } from "./intent_policy.js";
import { resolveProjectId } from "./intent_handlers.js";
import { resolveAdapterRequestIds, runExplainSummaryFlow, runResolveFlow } from "./resolve_flow.js";
import { handleOpsCommand, handleParsedCommand, handlePrivateMessage } from "./command_flow.js";
import type { AdapterContext } from "./router_types.js";
import { clip, nowIso, taskPrefix } from "./router_utils.js";

type PrimaryCommandMeta = IntentMeta & {
  name: "alert_strategy" | "alert_query";
  commandPattern: RegExp;
  groupCommandPattern?: RegExp;
};

const PRIMARY_COMMAND_META: Record<PrimaryCommandMeta["name"], PrimaryCommandMeta> = {
  alert_strategy: {
    ...INTENT_REGISTRY.alert_strategy,
    name: "alert_strategy",
    commandPattern: /^(?:\/strategy|策略|告警策略|alert_strategy)\b/i,
    groupCommandPattern: /^\/strategy\b/i,
  },
  alert_query: {
    ...INTENT_REGISTRY.alert_query,
    name: "alert_query",
    commandPattern: /^\/(event|evidence|gate|eval|evaluation|reliability|config|health)\b/i,
  },
};

function matchPrimaryCommand(meta: PrimaryCommandMeta, ctx: AdapterContext): boolean {
  if (!isIntentEnabledByName(meta.name)) return false;
  if (!meta.commandPattern.test(ctx.cleanedText)) return false;
  if (ctx.isGroup && meta.groupCommandPattern && !meta.groupCommandPattern.test(ctx.cleanedText)) {
    return false;
  }
  return true;
}

function resolveAdapterIdsForContext(ctx: AdapterContext) {
  return resolveAdapterRequestIds({
    channel: ctx.channel,
    chatId: ctx.chatId,
    messageId: ctx.messageId,
    replyToId: ctx.replyToId,
    explicitRetry: ctx.explicitRetry,
  });
}

function wantsRetry(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return /(?:^|\s)(retry|重试)(?:$|\s)/i.test(t);
}

function buildAdapterContext(params: {
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
  send: (chatId: string, text: string) => Promise<void>;
}): AdapterContext {
  const trimmedText = String(params.text || "").trim();
  const trimmedReplyText = String(params.replyText || "").trim();
  const hints = buildIntentHints({
    channel: params.channel,
    text: trimmedText,
    isGroup: params.isGroup,
    mentionsBot: params.mentionsBot,
    replyToId: params.replyToId,
  });
  const explicitRetry = wantsRetry(hints.intentRawText);
  const isPrivate = !params.isGroup;
  const projectId = resolveProjectId(params.config);
  const defaultWindowSpecId = resolveDefaultWindowSpecId(projectId || undefined) || undefined;
  return {
    ...params,
    trimmedText,
    trimmedReplyText,
    cleanedText: hints.cleanedText,
    intentRawText: hints.intentRawText,
    summaryRequested: hints.summaryRequested,
    explainRequested: hints.explainRequested,
    resolveText: hints.resolveText,
    allowResolve: hints.allowResolve,
    explicitRetry,
    isPrivate,
    projectId,
    defaultWindowSpecId,
  };
}

async function runPrimaryIntentPipeline(ctx: AdapterContext): Promise<boolean> {
  const steps: Array<PipelineStep<AdapterContext, any>> = [
    {
      name: "alert_strategy",
      priority: 30,
      match: (c) => {
        return { matched: matchPrimaryCommand(PRIMARY_COMMAND_META.alert_strategy, c) };
      },
      run: async (c) => {
        const adapterIds = resolveAdapterIdsForContext(c);
        const handled = await handleStrategyIfAny({
          storageDir: c.storageDir,
          config: c.config,
          allowlistMode: c.allowlistMode,
          ownerChatId: c.ownerChatId,
          ownerUserId: c.ownerUserId,
          channel: c.channel,
          chatId: c.chatId,
          userId: c.userId,
          isGroup: c.isGroup,
          mentionsBot: c.mentionsBot,
          text: c.cleanedText,
          send: c.send,
          adapterEntry: true,
          requestId: adapterIds?.dispatchRequestId,
          requestIdBase: adapterIds?.requestIdBase,
          attempt: adapterIds?.attempt,
        });
        return { handled };
      },
    },
    {
      name: "alert_query",
      priority: 20,
      match: (c) => {
        return { matched: matchPrimaryCommand(PRIMARY_COMMAND_META.alert_query, c) };
      },
      run: async (c) => {
        const adapterIds = resolveAdapterIdsForContext(c);
        const handled = await handleQueryIfAny({
          storageDir: c.storageDir,
          config: c.config,
          allowlistMode: c.allowlistMode,
          ownerChatId: c.ownerChatId,
          ownerUserId: c.ownerUserId,
          channel: c.channel,
          chatId: c.chatId,
          userId: c.userId,
          isGroup: c.isGroup,
          mentionsBot: c.mentionsBot,
          text: c.cleanedText,
          send: c.send,
          adapterEntry: true,
          requestId: adapterIds?.dispatchRequestId,
          requestIdBase: adapterIds?.requestIdBase,
          attempt: adapterIds?.attempt,
        });
        return { handled };
      },
    },
    {
      name: "dashboard_export",
      priority: 10,
      match: (c) => {
        if (c.isPrivate) return { matched: false };
        if (!isIntentEnabled("dashboard_export")) return { matched: false };
        if (!c.trimmedText) return { matched: false };
        const intent = parseDashboardIntent(c.trimmedText, { defaultWindowSpecId: c.defaultWindowSpecId });
        if (!intent) return { matched: false };
        return { matched: true, data: intent };
      },
      run: async (c, match: MatchResult<ReturnType<typeof parseDashboardIntent>>) => {
        const dashIntent = match.data;
        if (!dashIntent) return { handled: false };
        const adapterIds = resolveAdapterIdsForContext(c);
        const handled = await dispatchDashboardExport({
          storageDir: c.storageDir,
          config: c.config,
          allowlistMode: c.allowlistMode,
          ownerChatId: c.ownerChatId,
          ownerUserId: c.ownerUserId,
          channel: c.channel,
          chatId: c.chatId,
          messageId: c.messageId,
          replyToId: c.replyToId,
          userId: c.userId,
          text: c.text,
          isGroup: c.isGroup,
          mentionsBot: c.mentionsBot,
          replyText: c.trimmedReplyText,
          sendText: c.send,
          intent: dashIntent,
          adapterEntry: true,
          requestId: adapterIds?.dispatchRequestId,
          requestIdBase: adapterIds?.requestIdBase,
          attempt: adapterIds?.attempt,
          requestExpired: adapterIds?.expired,
        });
        return { handled };
      },
    },
  ];
  return runPipeline(ctx, steps);
}

export async function handleAdapterIntentIfAny(params: {
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
  isGroup: boolean;
  mentionsBot: boolean;
  replyText: string;
  send: (chatId: string, text: string) => Promise<void>;
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
    send,
  } = params;

  const ctx = buildAdapterContext({
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
    replyText,
    isGroup,
    mentionsBot,
    send,
  });

  const {
    trimmedText,
    trimmedReplyText,
    cleanedText,
    intentRawText,
    summaryRequested,
    explainRequested,
    allowResolve,
    isPrivate,
  } = ctx;

  if (!trimmedText && !trimmedReplyText) return false;

  if (process.env.CHAT_GATEWAY_ROUTE_TRACE === "1") {
    appendLedger(storageDir, {
      ts_utc: nowIso(),
      channel,
      chat_id: chatId,
      user_id: userId,
      cmd: "route_hint",
      is_group: isGroup,
      mentions_bot: mentionsBot,
      has_reply: Boolean(trimmedReplyText),
      reply_to_id: replyToId,
      allow_resolve: allowResolve,
      explain_requested: explainRequested,
      summary_requested: summaryRequested,
      cleaned_text: clip(cleanedText, 200),
      raw_text: clip(intentRawText, 200),
    });
  }

  if (await runPrimaryIntentPipeline(ctx)) {
    return true;
  }

  let pendingResolveResponse: string | null = null;

  if (trimmedReplyText && isPrivate) {
    setLastAlert(storageDir, chatId, trimmedReplyText);
  }

  const resolveFlow = await runResolveFlow(ctx);
  if (resolveFlow.done) {
    return resolveFlow.result;
  }
  pendingResolveResponse = resolveFlow.pending;

  return await runExplainSummaryFlow(ctx, pendingResolveResponse);
}

export async function handleMessage(opts: {
  storageDir: string;
  channel: string;
  ownerChatId: string;
  // NOTE: ownerChatId is private chat_id; group owner gating must use ownerUserId
  ownerUserId?: string;
  allowlistMode: "owner_only" | "auth";
  config?: LoadedConfig;
  limiter: RateLimiter;
  chatId: string;
  userId: string;
  messageId: string;
  replyToId: string;
  text: string;
  replyText?: string;
  isGroup?: boolean;
  mentionsBot?: boolean;
  send: (chatId: string, text: string) => Promise<void>;
}) {
  const {
    storageDir,
    channel,
    ownerChatId,
    ownerUserId,
    allowlistMode,
    config,
    chatId,
    userId,
    messageId,
    replyToId,
    text,
    replyText = "",
    isGroup = false,
    mentionsBot = false,
    send,
    limiter,
  } = opts;

  const trimmedText = (text || "").trim();
  const authState = loadAuth(storageDir, ownerChatId, channel);
  const resolvedOwnerUserId = String(ownerUserId || "");
  const isOwnerChat = chatId === ownerChatId;
  const isOwnerUser = resolvedOwnerUserId ? userId === resolvedOwnerUserId : false;
  const isOwner = isOwnerChat || isOwnerUser;
  const allowed =
    allowlistMode === "owner_only"
      ? (isGroup ? isOwnerUser : isOwnerChat)
      : authState.allowed.includes(chatId) || isOwnerUser;

  const botUsername = channel === "telegram"
    ? String(process.env.TELEGRAM_BOT_USERNAME || "SoliaNLBot")
    : "";
  const mentionToken = botUsername
    ? (botUsername.startsWith("@") ? botUsername : `@${botUsername}`)
    : "";
  const mentionPattern = mentionToken ? new RegExp(escapeRegExp(mentionToken), "gi") : null;
  // Strip @bot mention for command parsing in groups (e.g. "@SoliaNLBot /status")
  const cleanedText =
    channel === "telegram" && isGroup && mentionsBot && mentionPattern
      ? trimmedText.replace(mentionPattern, "").trim()
      : trimmedText;
  const taskIdPrefix = taskPrefix(channel);
  const isCommand = cleanedText.startsWith("/");

  const trimmedReplyText = (replyText || "").trim();

  // allow "/whoami" in both private and group (group may include mention)
  const isWhoami =
    cleanedText === "/whoami" ||
    cleanedText.endsWith(" /whoami") ||
    cleanedText.includes("/whoami");

  if (isWhoami) {
    await send(chatId, `chatId=${chatId}\nuserId=${userId}\nisGroup=${isGroup}`);
    return;
  }

  if (trimmedText === "👍" || trimmedText === "👎") {
    const last = getLastExplainTrace(chatId);
    if (!last) {
      await send(chatId, INTERACTION_MESSAGES.explainFeedbackMissing);
      return;
    }
    writeExplainFeedback(storageDir, {
      ts_utc: new Date().toISOString(),
      trace_id: last.trace_id,
      chat_id: chatId,
      user_id: userId,
      feedback: trimmedText === "👍" ? "up" : "down",
    });
    await send(chatId, INTERACTION_MESSAGES.explainFeedbackRecorded);
    return;
  }

  const handledOps = await handleOpsCommand({
    storageDir,
    channel,
    cleanedText,
    config,
    chatId,
    userId,
    mentionsBot,
    trimmedReplyText,
    isGroup,
    allowed,
    send,
  });
  if (handledOps) return;

  if (isGroup) {
    // ---- Group command path: allow commands without @bot (still owner/allowlist gated) ----
    if (isCommand) {
      if (!allowed) {
        await send(chatId, ACCESS_MESSAGES.ownerOnlyExplainWithEmoji);
        return;
      }
      // fall through to command parsing/dispatch below
    } else {
      return;
    }
  }

  if (!allowed && !isGroup) return;

  if (!isGroup) {
    const handledPrivate = await handlePrivateMessage({
      channel,
      taskIdPrefix,
      storageDir,
      chatId,
      userId,
      messageId,
      replyToId,
      trimmedText,
      trimmedReplyText,
      isCommand,
      send,
      config,
    });
    if (handledPrivate) return;
  }

  if (!isCommand) return;

  const cmd = parseCommand(cleanedText);
  await handleParsedCommand({
    cmd,
    channel,
    taskIdPrefix,
    storageDir,
    chatId,
    userId,
    text,
    isOwner,
    authState,
    send,
    config,
  });
}
