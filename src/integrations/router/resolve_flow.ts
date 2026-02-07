import { appendLedger } from "../audit/ledger.js";
import { loadAuth } from "../auth/store.js";
import { checkExplainGate } from "./intent_gate.js";
import { getLastAlert } from "./state_cache.js";
import { runPipeline, type PipelineStep } from "./intent_pipeline.js";
import { requestIntentResolve, sanitizeRequestId } from "../runtime/intent_router.js";
import { INTENT_SCHEMA_VERSION, INTENT_VERSION } from "../runtime/intent_schema.js";
import { buildDashboardIntentFromResolve, dispatchDashboardExport, handleAlertFeedbackIntent, handleResolvedChartIntent } from "../runtime/handlers.js";
import { handleAlertLevelIntent } from "../runtime/alert_level.js";
import { handleCognitiveIfAny, handleCognitiveStatusUpdate } from "../runtime/cognitive.js";
import { errorText, clarifyText, rejectText } from "../runtime/response_templates.js";
import { isIntentEnabled } from "../runtime/capabilities.js";
import type { LoadedConfig } from "../../core/config/types.js";
import type { AdapterContext } from "./router_types.js";
import { nowIso, parseIntEnv, taskPrefix } from "./router_utils.js";
import {
  COMMAND_MESSAGES,
  INTERACTION_MESSAGES,
  RESOLVE_MESSAGES,
  getIntentMeta,
  isIntentEnabledByName,
  resolveGroupDenyAction,
  resolveIntentDisabledMessage,
  resolveIntentMessage,
  type IntentMeta,
} from "./intent_policy.js";
import {
  NEWS_SUMMARY_MAX_CHARS,
  buildDispatchRequestId,
  isNewsAlert,
  resolveSummaryLength,
  runDataFeedsAssetStatus,
  runDataFeedsHotspots,
  runDataFeedsOpsSummary,
  runDataFeedsSourceStatus,
  runDataFeedsStatus,
  runExplain,
  runNewsQuery,
  runNewsSummary,
} from "./intent_handlers.js";

export type ResolveFlowResult = {
  done: boolean;
  result: boolean;
  pending: string | null;
};

type AdapterDedupeState = {
  firstTs: number;
  lastTs: number;
  attempt: number;
};

const adapterDedupe = new Map<string, AdapterDedupeState>();
const ADAPTER_DEDUPE_CLEANUP_THRESHOLD = 5000;
const ADAPTER_DEDUPE_CLEANUP_INTERVAL_MS = parseIntEnv("CHAT_GATEWAY_DEDUPE_CLEANUP_MS", 60_000);
const ADAPTER_DEDUPE_WINDOW_SEC = parseIntEnv(
  "DEDUPE_WINDOW_SEC",
  parseIntEnv("CHAT_GATEWAY_DEDUPE_WINDOW_SEC", 60),
);

// Lightweight cleanup implementation (inline to avoid extra state object allocation)
let adapterDedupeLastCleanup = 0;
function cleanupAdapterDedupeInner(now: number) {
  if (now - adapterDedupeLastCleanup < ADAPTER_DEDUPE_CLEANUP_INTERVAL_MS
    && adapterDedupe.size < ADAPTER_DEDUPE_CLEANUP_THRESHOLD) {
    return;
  }
  adapterDedupeLastCleanup = now;
  const maxAgeSec = Math.max(ADAPTER_DEDUPE_WINDOW_SEC * 2, 600);
  for (const [key, state] of adapterDedupe) {
    const ageSec = (now - state.lastTs) / 1000;
    if (ageSec > maxAgeSec) adapterDedupe.delete(key);
  }
}

export function resolveAdapterRequestIds(params: {
  channel: string;
  chatId: string;
  messageId: string;
  replyToId: string;
  explicitRetry?: boolean;
}): { requestIdBase: string; dispatchRequestId: string; attempt: number; expired: boolean; reused: boolean } | null {
  const requestKey = String(params.messageId || "").trim() || String(params.replyToId || "").trim();
  if (!requestKey) return null;

  const requestIdBase = sanitizeRequestId([params.channel, params.chatId, requestKey].join(":"));
  const now = Date.now();
  const state = adapterDedupe.get(requestIdBase);
  const explicitRetry = Boolean(params.explicitRetry);

  if (!state) {
    adapterDedupe.set(requestIdBase, { firstTs: now, lastTs: now, attempt: 1 });
    cleanupAdapterDedupeInner(now);
    return {
      requestIdBase,
      dispatchRequestId: buildDispatchRequestId(requestIdBase, 1),
      attempt: 1,
      expired: false,
      reused: false,
    };
  }

  if (explicitRetry) {
    state.attempt += 1;
    state.firstTs = now;
    state.lastTs = now;
    cleanupAdapterDedupeInner(now);
    return {
      requestIdBase,
      dispatchRequestId: buildDispatchRequestId(requestIdBase, state.attempt),
      attempt: state.attempt,
      expired: false,
      reused: false,
    };
  }

  state.lastTs = now;
  const ageSec = (now - state.firstTs) / 1000;
  const expired = ADAPTER_DEDUPE_WINDOW_SEC > 0 && ageSec > ADAPTER_DEDUPE_WINDOW_SEC;
  cleanupAdapterDedupeInner(now);
  return {
    requestIdBase,
    dispatchRequestId: buildDispatchRequestId(requestIdBase, state.attempt),
    attempt: state.attempt,
    expired,
    reused: true,
  };
}

type ResolveResult = Awaited<ReturnType<typeof requestIntentResolve>>;

type ResolvedDashboardIntent = ReturnType<typeof buildDashboardIntentFromResolve>;

type ResolveStepParams = {
  ctx: AdapterContext;
  resolveRes: ResolveResult;
  adapterIds: NonNullable<ReturnType<typeof resolveAdapterRequestIds>>;
  resolvedIntent: ResolvedDashboardIntent;
  setPending: (text: string) => void;
};

async function runResolvePipeline(
  ctx: AdapterContext,
  steps: Array<PipelineStep<AdapterContext, any>>,
): Promise<{ handled: boolean; result: boolean }> {
  const ordered = steps
    .slice()
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const step of ordered) {
    const match = step.match(ctx);
    if (!match.matched) continue;
    const outcome = await step.run(ctx, match);
    if (outcome.handled || outcome.stop) {
      return { handled: true, result: outcome.result ?? true };
    }
  }
  return { handled: false, result: false };
}

function resolveIntentMeta(intent?: string | null): IntentMeta | null {
  return getIntentMeta(intent);
}

async function ensureIntentEnabled(
  ctx: AdapterContext,
  intent: string,
  meta?: IntentMeta | null,
): Promise<boolean> {
  const resolved = meta ?? getIntentMeta(intent);
  const key = resolved?.enabledKey || intent;
  if (!isIntentEnabled(key)) {
    const message = resolved?.disabledMessage || "未开放相关能力。";
    await ctx.send(ctx.chatId, rejectText(message));
    return false;
  }
  return true;
}

async function ensureIntentAuthorized(
  ctx: AdapterContext,
  intent: string,
  meta?: IntentMeta | null,
): Promise<boolean> {
  const resolved = meta ?? getIntentMeta(intent);
  if (!resolved?.requiresAuth) return true;
  if (!isAllowedChat({
    storageDir: ctx.storageDir,
    allowlistMode: ctx.allowlistMode,
    ownerChatId: ctx.ownerChatId,
    ownerUserId: ctx.ownerUserId,
    channel: ctx.channel,
    chatId: ctx.chatId,
    userId: ctx.userId,
    isGroup: ctx.isGroup,
  })) {
    const message = resolved?.denyMessage || "未授权操作";
    await ctx.send(ctx.chatId, rejectText(message));
    return false;
  }
  return true;
}

async function ensureResolveIntentEnabled(
  ctx: AdapterContext,
  intent: string,
): Promise<boolean> {
  return ensureIntentEnabled(ctx, intent, resolveIntentMeta(intent));
}

async function ensureResolveIntentAuthorized(
  ctx: AdapterContext,
  intent: string,
): Promise<boolean> {
  return ensureIntentAuthorized(ctx, intent, resolveIntentMeta(intent));
}

async function ensureResolveIntentReady(
  ctx: AdapterContext,
  intent: string,
): Promise<boolean> {
  if (!await ensureResolveIntentEnabled(ctx, intent)) return false;
  return ensureResolveIntentAuthorized(ctx, intent);
}

type IntentGateContext = Pick<
  AdapterContext,
  | "storageDir"
  | "allowlistMode"
  | "ownerChatId"
  | "ownerUserId"
  | "channel"
  | "chatId"
  | "userId"
  | "isGroup"
  | "mentionsBot"
  | "send"
> & { config?: LoadedConfig };

async function applyExplainGate(params: {
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
  send: (chatId: string, text: string) => Promise<void>;
}): Promise<{ allowed: boolean; handled: boolean }> {
  const gate = checkExplainGate({
    storageDir: params.storageDir,
    config: params.config,
    allowlistMode: params.allowlistMode,
    ownerChatId: params.ownerChatId,
    ownerUserId: params.ownerUserId,
    channel: params.channel,
    chatId: params.chatId,
    userId: params.userId,
    isGroup: params.isGroup,
    mentionsBot: params.mentionsBot,
    hasReply: params.hasReply,
  });
  if (!gate.allowed) {
    if (gate.block === "reply" && gate.message) {
      await params.send(params.chatId, gate.message);
    }
    return { allowed: false, handled: gate.block !== "ignore" };
  }
  return { allowed: true, handled: false };
}

async function applyIntentGate(
  ctx: IntentGateContext,
  intent: string,
  hasReply: boolean,
): Promise<{ allowed: boolean; handled: boolean }> {
  const meta = getIntentMeta(intent);
  if (meta?.gateKind === "explain") {
    return applyExplainGate({
      storageDir: ctx.storageDir,
      config: ctx.config,
      allowlistMode: ctx.allowlistMode,
      ownerChatId: ctx.ownerChatId,
      ownerUserId: ctx.ownerUserId,
      channel: ctx.channel,
      chatId: ctx.chatId,
      userId: ctx.userId,
      isGroup: ctx.isGroup,
      mentionsBot: ctx.mentionsBot,
      hasReply,
      send: ctx.send,
    });
  }
  return { allowed: true, handled: false };
}

function isAllowedChat(params: {
  storageDir: string;
  allowlistMode: "owner_only" | "auth";
  ownerChatId: string;
  ownerUserId?: string;
  channel: string;
  chatId: string;
  userId: string;
  isGroup: boolean;
}): boolean {
  const {
    storageDir,
    allowlistMode,
    ownerChatId,
    ownerUserId,
    channel,
    chatId,
    userId,
    isGroup,
  } = params;
  const authState = loadAuth(storageDir, ownerChatId, channel);
  const resolvedOwnerUserId = String(ownerUserId || "");
  const isOwnerChat = chatId === ownerChatId;
  const isOwnerUser = resolvedOwnerUserId ? userId === resolvedOwnerUserId : userId === ownerChatId;
  return allowlistMode === "owner_only"
    ? (isGroup ? isOwnerUser : isOwnerChat)
    : authState.allowed.includes(chatId) || isOwnerUser;
}

function buildResolveSteps(params: ResolveStepParams): Array<PipelineStep<AdapterContext, any>> {
  const { ctx, resolveRes, adapterIds, resolvedIntent, setPending } = params;
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
    trimmedReplyText,
    resolveText,
    intentRawText,
    isPrivate,
    explicitRetry,
    send,
  } = ctx;

  return [
    {
      name: "dashboard_resolve",
      priority: 100,
      match: () => ({ matched: Boolean(resolvedIntent) }),
      run: async () => {
        if (!resolvedIntent) return { handled: false };
        const handled = await dispatchDashboardExport({
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
          replyText: trimmedReplyText,
          sendText: send,
          intent: resolvedIntent,
          adapterEntry: true,
          requestId: adapterIds.dispatchRequestId,
          requestIdBase: adapterIds.requestIdBase,
          attempt: adapterIds.attempt,
          requestExpired: adapterIds.expired,
        });
        return { handled: true, result: handled };
      },
    },
    {
      name: "cognitive_record",
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "cognitive_record" }),
      run: async () => {
        const resolvedParams = resolveRes.params && typeof resolveRes.params === "object"
          ? resolveRes.params
          : {};
        const resolvedText = typeof resolvedParams.record_text === "string"
          ? resolvedParams.record_text.trim()
          : typeof resolvedParams.text === "string"
            ? resolvedParams.text.trim()
            : typeof resolvedParams.content === "string"
              ? resolvedParams.content.trim()
              : "";
        const recordSource = typeof resolvedParams.record_source === "string"
          ? resolvedParams.record_source.trim().toLowerCase()
          : typeof resolvedParams.text_source === "string"
            ? resolvedParams.text_source.trim().toLowerCase()
            : "";
        const useReplyOverride = recordSource === "reply";
        const inputText = resolvedText || (useReplyOverride ? trimmedReplyText : "");
        if (resolveRes.needClarify || !inputText) {
          await send(chatId, "请明确要记录的内容（例如：记录一下 XXX）。");
          return { handled: true };
        }
        const handled = await handleCognitiveIfAny({
          storageDir,
          config,
          allowlistMode,
          ownerChatId,
          ownerUserId,
          channel,
          chatId,
          userId,
          messageId,
          replyToId,
          replyText: trimmedReplyText,
          text: inputText,
          isGroup,
          mentionsBot,
          send,
          useReplyOverride,
          decisionOverride: {
            action: "record",
            confidence: Math.max(0, Number(resolveRes.confidence) || 0),
            reason: resolveRes.reason || "intent_resolve",
          },
        });
        return { handled };
      },
    },
    {
      name: "cognitive_confirm",
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "cognitive_confirm" }),
      run: async () => {
        const action = resolveRes.params?.action;
        if (action === "record" || action === "ignore") {
          const handled = await handleCognitiveIfAny({
            storageDir,
            config,
            allowlistMode,
            ownerChatId,
            ownerUserId,
            channel,
            chatId,
            userId,
            messageId,
            replyToId,
            replyText: trimmedReplyText,
            text: resolveText || intentRawText,
            isGroup,
            mentionsBot,
            send,
            confirmOverride: action,
          });
          return { handled };
        }
        if (resolveRes.needClarify) {
          setPending(INTERACTION_MESSAGES.cognitiveConfirmPrompt);
        }
        return { handled: false };
      },
    },
    {
      name: "cognitive_status_update",
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "cognitive_status_update" }),
      run: async () => {
        const issueId = typeof resolveRes.params?.id === "string" ? resolveRes.params.id.trim() : "";
        const status = typeof resolveRes.params?.status === "string" ? resolveRes.params.status.trim() : "";
        if (issueId && status) {
          const handled = await handleCognitiveStatusUpdate({
            storageDir,
            config,
            allowlistMode,
            ownerChatId,
            ownerUserId,
            channel,
            chatId,
            userId,
            text: resolveText || intentRawText,
            isGroup,
            mentionsBot,
            send,
            statusOverride: { id: issueId, status },
          });
          return { handled };
        }
        if (resolveRes.needClarify) {
          setPending(INTERACTION_MESSAGES.cognitiveStatusPrompt);
        }
        return { handled: false };
      },
    },
    {
      name: "chart_resolve",
      match: () => ({
        matched: resolveRes.ok
          && (resolveRes.intent === "chart_factor_timeline" || resolveRes.intent === "chart_daily_activity"),
      }),
      run: async () => {
        if (channel !== "telegram") {
          setPending(rejectText(INTERACTION_MESSAGES.chartTelegramOnly));
          return { handled: false };
        }
        const handled = await handleResolvedChartIntent({
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
          isGroup,
          mentionsBot,
          replyText: trimmedReplyText,
          sendText: send,
          resolved: resolveRes,
        });
        return { handled };
      },
    },
    {
      name: "alert_explain_adapter",
      priority: 50,
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "alert_explain" }),
      run: async () => {
        const handled = await handleAlertExplainIntent({
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
          isGroup,
          mentionsBot,
          replyText: trimmedReplyText,
          send,
          explicitRetry,
          rawAlertOverride: trimmedReplyText,
        });
        return { handled };
      },
    },
    {
      name: "alert_feedback",
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "alert_feedback" }),
      run: async () => {
        if (isGroup) {
          await send(chatId, "群聊请用 /feedback <描述>。");
          return { handled: true };
        }
        const handled = await handleAlertFeedbackIntent({
          storageDir,
          channel,
          chatId,
          userId,
          isGroup,
          allowlistMode,
          ownerChatId,
          ownerUserId,
          send,
          rawText: resolveText || intentRawText,
          feedbackKind: resolveRes.params?.feedback_kind,
          minPriority: resolveRes.params?.min_priority,
        });
        return { handled };
      },
    },
    {
      name: "alert_level",
      match: () => ({
        matched: resolveRes.ok
          && (resolveRes.intent === "alert_level_query" || resolveRes.intent === "alert_level_set"),
      }),
      run: async () => {
        const intent = resolveRes.intent === "alert_level_query" || resolveRes.intent === "alert_level_set"
          ? resolveRes.intent
          : "alert_level_query";
        const handled = await handleAlertLevelIntent({
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
          send,
          intent,
          minPriority: resolveRes.params?.min_priority,
          requestId: adapterIds.dispatchRequestId,
          requestIdBase: adapterIds.requestIdBase,
          attempt: adapterIds.attempt,
          adapterEntry: true,
        });
        return { handled };
      },
    },
    {
      name: "data_feeds_status",
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "data_feeds_status" }),
      run: async () => {
        if (!await ensureResolveIntentReady(ctx, "data_feeds_status")) {
          return { handled: true };
        }
        await runDataFeedsStatus({
          storageDir,
          chatId,
          userId,
          channel,
          send,
          config,
          adapterEntry: true,
          requestId: adapterIds.dispatchRequestId,
          requestIdBase: adapterIds.requestIdBase,
          attempt: adapterIds.attempt,
        });
        return { handled: true };
      },
    },
    {
      name: "data_feeds_asset_status",
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "data_feeds_asset_status" }),
      run: async () => {
        if (!await ensureResolveIntentEnabled(ctx, "data_feeds_asset_status")) {
          return { handled: true };
        }
        const symbol = String(resolveRes.params?.symbol || "").trim();
        if (!symbol || resolveRes.needClarify) {
          await send(chatId, COMMAND_MESSAGES.feedsAssetMissing);
          return { handled: true };
        }
        if (!await ensureResolveIntentAuthorized(ctx, "data_feeds_asset_status")) {
          return { handled: true };
        }
        await runDataFeedsAssetStatus({
          storageDir,
          chatId,
          userId,
          channel,
          send,
          config,
          symbol,
          adapterEntry: true,
          requestId: adapterIds.dispatchRequestId,
          requestIdBase: adapterIds.requestIdBase,
          attempt: adapterIds.attempt,
        });
        return { handled: true };
      },
    },
    {
      name: "data_feeds_source_status",
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "data_feeds_source_status" }),
      run: async () => {
        if (!await ensureResolveIntentEnabled(ctx, "data_feeds_source_status")) {
          return { handled: true };
        }
        const feedId = String(resolveRes.params?.feed_id || "").trim();
        if (!feedId || resolveRes.needClarify) {
          await send(chatId, COMMAND_MESSAGES.feedsSourceMissing);
          return { handled: true };
        }
        if (!await ensureResolveIntentAuthorized(ctx, "data_feeds_source_status")) {
          return { handled: true };
        }
        await runDataFeedsSourceStatus({
          storageDir,
          chatId,
          userId,
          channel,
          send,
          config,
          feedId,
          adapterEntry: true,
          requestId: adapterIds.dispatchRequestId,
          requestIdBase: adapterIds.requestIdBase,
          attempt: adapterIds.attempt,
        });
        return { handled: true };
      },
    },
    {
      name: "data_feeds_hotspots",
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "data_feeds_hotspots" }),
      run: async () => {
        if (!await ensureResolveIntentReady(ctx, "data_feeds_hotspots")) {
          return { handled: true };
        }
        await runDataFeedsHotspots({
          storageDir,
          chatId,
          userId,
          channel,
          send,
          config,
          limit: resolveRes.params?.limit,
          adapterEntry: true,
          requestId: adapterIds.dispatchRequestId,
          requestIdBase: adapterIds.requestIdBase,
          attempt: adapterIds.attempt,
        });
        return { handled: true };
      },
    },
    {
      name: "data_feeds_ops_summary",
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "data_feeds_ops_summary" }),
      run: async () => {
        if (!await ensureResolveIntentReady(ctx, "data_feeds_ops_summary")) {
          return { handled: true };
        }
        await runDataFeedsOpsSummary({
          storageDir,
          chatId,
          userId,
          channel,
          send,
          config,
          limit: resolveRes.params?.limit,
          adapterEntry: true,
          requestId: adapterIds.dispatchRequestId,
          requestIdBase: adapterIds.requestIdBase,
          attempt: adapterIds.attempt,
        });
        return { handled: true };
      },
    },
    {
      name: "news_hot",
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "news_hot" }),
      run: async () => {
        if (!await ensureResolveIntentReady(ctx, "news_hot")) {
          return { handled: true };
        }
        await runNewsQuery({
          storageDir,
          chatId,
          userId,
          channel,
          send,
          config,
          kind: "news_hot",
          limit: resolveRes.params?.limit,
          adapterEntry: true,
          requestId: adapterIds.dispatchRequestId,
          requestIdBase: adapterIds.requestIdBase,
          attempt: adapterIds.attempt,
        });
        return { handled: true };
      },
    },
    {
      name: "news_refresh",
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "news_refresh" }),
      run: async () => {
        if (!await ensureResolveIntentReady(ctx, "news_refresh")) {
          return { handled: true };
        }
        await runNewsQuery({
          storageDir,
          chatId,
          userId,
          channel,
          send,
          config,
          kind: "news_refresh",
          limit: resolveRes.params?.limit,
          adapterEntry: true,
          requestId: adapterIds.dispatchRequestId,
          requestIdBase: adapterIds.requestIdBase,
          attempt: adapterIds.attempt,
        });
        return { handled: true };
      },
    },
    {
      name: "news_summary",
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "news_summary" }),
      run: async () => {
        if (!isIntentEnabledByName("news_summary")) {
          const meta = getIntentMeta("news_summary");
          setPending(rejectText(meta?.disabledMessage || "未开放新闻摘要能力。"));
          return { handled: false };
        }
        const resolvedParams = resolveRes.params && typeof resolveRes.params === "object"
          ? resolveRes.params
          : {};
        const rawMaxChars = resolvedParams.max_chars ?? resolvedParams.maxChars
          ?? resolvedParams.summary_chars ?? resolvedParams.chars;
        const parsedMax = Number(rawMaxChars);
        const maxChars = Number.isFinite(parsedMax)
          ? Math.max(1, Math.min(NEWS_SUMMARY_MAX_CHARS, Math.floor(parsedMax)))
          : resolveSummaryLength(intentRawText);
        let rawAlert = trimmedReplyText;
        if (!rawAlert && isPrivate) {
          rawAlert = getLastAlert(storageDir, chatId);
        }
        if (!rawAlert) {
          await send(
            chatId,
            resolveIntentMessage(
              "news_summary",
              "missingReplyResolve",
              "请先回复一条告警/新闻消息，然后发一句话（如：摘要 200）。",
            ),
          );
          return { handled: true };
        }
        if (!isNewsAlert(rawAlert)) {
          await send(
            chatId,
            resolveIntentMessage(
              "news_summary",
              "unsupported",
              "当前仅支持新闻摘要，请回复新闻告警再发“摘要 200”。",
            ),
          );
          return { handled: true };
        }
        const gateResult = await applyIntentGate(ctx, "news_summary", Boolean(trimmedReplyText));
        if (!gateResult.allowed) {
          return { handled: gateResult.handled };
        }
        await send(chatId, "🧠 正在生成新闻摘要…");
        await runNewsSummary({
          storageDir,
          chatId,
          userId,
          messageId,
          replyToId,
          rawAlert,
          send,
          channel,
          maxChars,
          config,
          adapterEntry: true,
          requestId: adapterIds.dispatchRequestId,
          requestIdBase: adapterIds.requestIdBase,
          attempt: adapterIds.attempt,
        });
        return { handled: true };
      },
    },
    {
      name: "alert_explain_news",
      match: () => ({ matched: resolveRes.ok && resolveRes.intent === "alert_explain" }),
      run: async () => {
        let rawAlert = trimmedReplyText;
        if (!rawAlert && isPrivate) {
          rawAlert = getLastAlert(storageDir, chatId);
        }
        if (!rawAlert) {
          await send(
            chatId,
            resolveIntentMessage(
              "alert_explain",
              "missingReplyPrivate",
              "请先回复一条告警/新闻消息，然后发一句话（如：解释一下）。",
            ),
          );
          return { handled: true };
        }
        if (isNewsAlert(rawAlert)) {
          if (!isIntentEnabledByName("news_summary")) {
            await send(
              chatId,
              rejectText(resolveIntentDisabledMessage("news_summary", "未开放新闻摘要能力。")),
            );
            return { handled: true };
          }
          await send(chatId, "🧠 正在生成新闻摘要…");
          await runNewsSummary({
            storageDir,
            chatId,
            userId,
            messageId,
            replyToId,
            rawAlert,
            send,
            channel,
            maxChars: resolveSummaryLength(intentRawText),
            config,
            adapterEntry: true,
            requestId: adapterIds.dispatchRequestId,
            requestIdBase: adapterIds.requestIdBase,
            attempt: adapterIds.attempt,
          });
          return { handled: true };
        }
        const gateResult = await applyIntentGate(ctx, "alert_explain", Boolean(trimmedReplyText));
        if (!gateResult.allowed) {
          return { handled: gateResult.handled };
        }
        await send(chatId, "🧠 我看一下…");
        const explainResult = await runExplain({
          storageDir,
          chatId,
          userId,
          rawAlert,
          send,
          config,
          channel,
          taskIdPrefix: `${taskPrefix(channel)}_explain`,
          isGroup,
          mentionsBot,
          hasReply: Boolean(trimmedReplyText),
        });
        appendAlertExplainLedger({
          storageDir,
          channel,
          chatId,
          userId,
          requestId: adapterIds.dispatchRequestId,
          requestIdBase: adapterIds.requestIdBase,
          attempt: adapterIds.attempt,
          ok: explainResult.ok,
          errCode: explainResult.ok ? undefined : explainResult.errCode || "unknown",
          latencyMs: explainResult.latencyMs,
          adapterEntry: true,
        });
        return { handled: true };
      },
    },
  ];
}

async function handleAlertExplainIntent(params: {
  storageDir: string;
  config: LoadedConfig | undefined;
  allowlistMode: "owner_only" | "auth";
  ownerChatId: string;
  ownerUserId: string;
  channel: "telegram" | "feishu";
  chatId: string;
  messageId: string;
  replyToId: string;
  userId: string;
  isGroup: boolean;
  mentionsBot: boolean;
  replyText: string;
  send: (chatId: string, text: string) => Promise<void>;
  explicitRetry: boolean;
  rawAlertOverride?: string;
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
    isGroup,
    mentionsBot,
    replyText,
    send,
    explicitRetry,
    rawAlertOverride,
  } = params;

  let rawAlert = rawAlertOverride || replyText;
  if (!rawAlert && !isGroup) {
    rawAlert = getLastAlert(storageDir, chatId);
  }
  if (!rawAlert) {
    if (isGroup) {
      await send(
        chatId,
        resolveIntentMessage("alert_explain", "missingReplyGroup", "请回复一条告警/新闻消息再 @我。"),
      );
    } else {
      await send(
        chatId,
        resolveIntentMessage(
          "alert_explain",
          "missingReplyPrivate",
          "请先回复一条告警/新闻消息，然后发一句话（如：解释一下）。",
        ),
      );
    }
    return true;
  }

  if (isNewsAlert(rawAlert)) {
    return false;
  }

  const gateResult = await applyIntentGate({
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
    send,
  }, "alert_explain", Boolean(replyText));
  if (!gateResult.allowed) {
    return gateResult.handled;
  }

  const adapterIds = resolveAdapterRequestIds({
    channel,
    chatId,
    messageId,
    replyToId,
    explicitRetry,
  });
  if (adapterIds?.expired) {
    await send(
      chatId,
      rejectText(resolveIntentMessage("alert_explain", "expired", "请求已过期，请重新发起解释。")),
    );
    appendLedger(storageDir, {
      ts_utc: nowIso(),
      channel,
      chat_id: chatId,
      user_id: userId,
      cmd: "alert_explain_reject",
      request_id: adapterIds.dispatchRequestId,
      request_id_base: adapterIds.requestIdBase,
      adapter_trace_id: adapterIds.requestIdBase,
      attempt: adapterIds.attempt,
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      error_code: "request_id_expired",
      raw: rawAlert,
      adapter_entry: true,
    });
    return true;
  }

  await send(chatId, "🧠 我看一下…");
  const explainResult = await runExplain({
    storageDir,
    chatId,
    userId,
    rawAlert,
    send,
    config,
    channel,
    taskIdPrefix: `${taskPrefix(channel)}_explain`,
    isGroup,
    mentionsBot,
    hasReply: Boolean(trimmedReplyText),
  });
  appendAlertExplainLedger({
    storageDir,
    channel,
    chatId,
    userId,
    requestId: adapterIds?.dispatchRequestId,
    requestIdBase: adapterIds?.requestIdBase,
    attempt: adapterIds?.attempt,
    ok: explainResult.ok,
    errCode: explainResult.ok ? undefined : explainResult.errCode || "unknown",
    latencyMs: explainResult.latencyMs,
    adapterEntry: true,
  });
  return true;
}

function appendAlertExplainLedger(params: {
  storageDir: string;
  channel: string;
  chatId: string;
  userId: string;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
  ok: boolean;
  errCode?: string;
  latencyMs?: number;
  adapterEntry?: boolean;
}) {
  const entry: any = {
    ts_utc: nowIso(),
    channel: params.channel,
    chat_id: params.chatId,
    user_id: params.userId,
    cmd: "alert_explain",
    request_id: params.requestId,
    request_id_base: params.requestIdBase,
    adapter_trace_id: params.requestIdBase,
    attempt: params.attempt,
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    ok: params.ok,
    err: params.ok ? undefined : params.errCode || "unknown",
    latency_ms: params.latencyMs,
  };
  if (params.adapterEntry) entry.adapter_entry = true;
  appendLedger(params.storageDir, entry);
}

function appendNewsSummaryReject(params: {
  storageDir: string;
  channel: string;
  chatId: string;
  userId: string;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
  errorCode: string;
  raw: string;
  adapterEntry?: boolean;
}) {
  const entry: any = {
    ts_utc: nowIso(),
    channel: params.channel,
    chat_id: params.chatId,
    user_id: params.userId,
    cmd: "news_summary_reject",
    request_id: params.requestId,
    request_id_base: params.requestIdBase,
    adapter_trace_id: params.requestIdBase,
    attempt: params.attempt,
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    error_code: params.errorCode,
    raw: params.raw,
  };
  if (params.adapterEntry) entry.adapter_entry = true;
  appendLedger(params.storageDir, entry);
}

const EXPLAIN_SUMMARY_STEPS: Array<PipelineStep<AdapterContext, any>> = [
  {
    name: "alert_explain",
    priority: 10,
    match: (c) => ({
      matched: c.explainRequested && isIntentEnabledByName("alert_explain"),
    }),
    run: async (c) => {
      const handled = await handleAlertExplainIntent({
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
        isGroup: c.isGroup,
        mentionsBot: c.mentionsBot,
        replyText: c.trimmedReplyText,
        send: c.send,
        explicitRetry: c.explicitRetry,
        rawAlertOverride: c.trimmedReplyText,
      });
      return { handled };
    },
  },
  {
    name: "news_summary",
    match: (c) => ({
      matched: c.summaryRequested || c.explainRequested,
    }),
    run: async (c) => {
      if (!isIntentEnabledByName("news_summary")) return { handled: false };

      let rawAlert = c.trimmedReplyText;
      if (!rawAlert && !c.isGroup) {
        rawAlert = getLastAlert(c.storageDir, c.chatId);
      }
      if (!rawAlert) {
        if (c.isGroup) {
          await c.send(
            c.chatId,
            resolveIntentMessage("news_summary", "missingReplyGroup", "请回复一条新闻告警再发送摘要请求。"),
          );
        } else {
          await c.send(
            c.chatId,
            resolveIntentMessage(
              "news_summary",
              "missingReplyPrivate",
              "请先回复一条告警/新闻消息，然后发一句话（如：解释一下 / 摘要 200）。",
            ),
          );
        }
        return { handled: true };
      }

      const isNews = isNewsAlert(rawAlert);
      const summaryIntent = c.summaryRequested || (isNews && c.explainRequested);
      if (!summaryIntent) return { handled: false };

      if (!isNews) {
        await c.send(
          c.chatId,
          resolveIntentMessage(
            "news_summary",
            "unsupported",
            "当前仅支持新闻摘要，请回复新闻告警再发“摘要 200”。",
          ),
        );
        return { handled: true };
      }

      const gateResult = await applyIntentGate(c, "news_summary", Boolean(c.trimmedReplyText));
      if (!gateResult.allowed) {
        return { handled: gateResult.handled };
      }

      const adapterIds = resolveAdapterRequestIds({
        channel: c.channel,
        chatId: c.chatId,
        messageId: c.messageId,
        replyToId: c.replyToId,
        explicitRetry: c.explicitRetry,
      });
      if (!adapterIds) {
        await runNewsSummary({
          storageDir: c.storageDir,
          chatId: c.chatId,
          userId: c.userId,
          messageId: c.messageId,
          replyToId: c.replyToId,
          rawAlert,
          send: c.send,
          channel: c.channel,
          maxChars: resolveSummaryLength(c.trimmedText),
          config: c.config,
          adapterEntry: true,
        });
        return { handled: true };
      }

      if (!c.projectId) {
        await c.send(
          c.chatId,
          rejectText(resolveIntentMessage("news_summary", "missingProject", "未配置默认项目，无法生成摘要。")),
        );
        appendNewsSummaryReject({
          storageDir: c.storageDir,
          channel: c.channel,
          chatId: c.chatId,
          userId: c.userId,
          requestId: adapterIds.dispatchRequestId,
          requestIdBase: adapterIds.requestIdBase,
          attempt: adapterIds.attempt,
          errorCode: "missing_project_id",
          raw: c.trimmedText,
          adapterEntry: true,
        });
        return { handled: true };
      }

      if (adapterIds.expired) {
        await c.send(
          c.chatId,
          rejectText(resolveIntentMessage("news_summary", "expired", "请求已过期，请重新发起摘要。")),
        );
        appendNewsSummaryReject({
          storageDir: c.storageDir,
          channel: c.channel,
          chatId: c.chatId,
          userId: c.userId,
          requestId: adapterIds.dispatchRequestId,
          requestIdBase: adapterIds.requestIdBase,
          attempt: adapterIds.attempt,
          errorCode: "request_id_expired",
          raw: c.trimmedText,
          adapterEntry: true,
        });
        return { handled: true };
      }

      await c.send(c.chatId, "🧠 正在生成新闻摘要…");
      await runNewsSummary({
        storageDir: c.storageDir,
        chatId: c.chatId,
        userId: c.userId,
        messageId: c.messageId,
        replyToId: c.replyToId,
        rawAlert,
        send: c.send,
        channel: c.channel,
        maxChars: resolveSummaryLength(c.trimmedText),
        config: c.config,
        adapterEntry: true,
        requestId: adapterIds.dispatchRequestId,
        requestIdBase: adapterIds.requestIdBase,
        attempt: adapterIds.attempt,
      });
      return { handled: true };
    },
  },
];

async function sendPendingIfAny(
  pending: string | null,
  send: (chatId: string, text: string) => Promise<void>,
  chatId: string,
): Promise<boolean> {
  if (!pending) return false;
  await send(chatId, pending);
  return true;
}

export async function runExplainSummaryFlow(
  ctx: AdapterContext,
  pendingResolveResponse: string | null,
): Promise<boolean> {
  const {
    chatId,
    isGroup,
    summaryRequested,
    explainRequested,
    allowResolve,
    isPrivate,
    send,
  } = ctx;
  const wantsExplainOrSummary = summaryRequested || explainRequested;

  if (isGroup && !allowResolve && !wantsExplainOrSummary) {
    return false;
  }

  if ((isPrivate || allowResolve) && !wantsExplainOrSummary) {
    if (await sendPendingIfAny(pendingResolveResponse, send, chatId)) {
      return true;
    }
    return false;
  }

  if (await runPipeline(ctx, EXPLAIN_SUMMARY_STEPS)) {
    return true;
  }

  if (!isIntentEnabledByName("news_summary")) {
    if (await sendPendingIfAny(pendingResolveResponse, send, chatId)) {
      return true;
    }
    return false;
  }

  return false;
}

export async function runResolveFlow(ctx: AdapterContext): Promise<ResolveFlowResult> {
  if (!ctx.allowResolve) return { done: false, result: false, pending: null };

  const {
    channel,
    chatId,
    messageId,
    replyToId,
    explicitRetry,
    projectId,
    resolveText,
    trimmedReplyText,
    userId,
    storageDir,
    config,
    allowlistMode,
    ownerChatId,
    ownerUserId,
    isGroup,
    mentionsBot,
    intentRawText,
    isPrivate,
    defaultWindowSpecId,
    text,
    send,
  } = ctx;

  let pendingResolveResponse: string | null = null;
  const setPending = (text: string) => {
    pendingResolveResponse = text;
  };
  const adapterIds = resolveAdapterRequestIds({
    channel,
    chatId,
    messageId,
    replyToId,
    explicitRetry,
  });
  if (adapterIds && projectId) {
    const resolveRes = await requestIntentResolve({
      projectId,
      requestId: adapterIds.requestIdBase,
      rawQuery: resolveText,
      replyText: trimmedReplyText,
      channel,
      chatId,
      userId,
    });

    appendLedger(storageDir, {
      ts_utc: nowIso(),
      channel,
      chat_id: chatId,
      user_id: userId,
      cmd: "intent_resolve",
      raw: resolveText,
      intent: resolveRes.intent,
      params: resolveRes.params,
      confidence: resolveRes.confidence,
      reason: resolveRes.reason,
      unknown_reason: resolveRes.unknownReason,
      request_id: adapterIds.dispatchRequestId,
      request_id_base: adapterIds.requestIdBase,
      adapter_trace_id: adapterIds.requestIdBase,
      attempt: adapterIds.attempt,
      schema_version: resolveRes.schemaVersion || INTENT_SCHEMA_VERSION,
      intent_version: resolveRes.intentVersion || INTENT_VERSION,
      adapter_entry: true,
    });

    const resolvedIntent = buildDashboardIntentFromResolve({
      resolved: resolveRes,
      rawQuery: resolveText,
      defaultWindowSpecId,
    });

    if (resolveRes.ok && resolveRes.intent && isGroup) {
      const groupAction = resolveGroupDenyAction(resolveRes.intent);
      if (groupAction === "ignore") {
        return { done: true, result: false, pending: null };
      }
      if (groupAction === "reject") {
        const meta = getIntentMeta(resolveRes.intent);
        await send(chatId, rejectText(meta?.groupDenyMessage || meta?.disabledMessage || "未开放相关能力。"));
        return { done: true, result: true, pending: null };
      }
    }

    const steps = buildResolveSteps({ ctx, resolveRes, adapterIds, resolvedIntent, setPending });

    const pipelineResult = await runResolvePipeline(ctx, steps);
    if (pipelineResult.handled) {
      return { done: true, result: pipelineResult.result, pending: null };
    }

    if (resolveRes.ok && (resolveRes.needClarify || resolveRes.intent === "unknown")) {
      pendingResolveResponse = clarifyText(RESOLVE_MESSAGES.clarifyUnknown);
    } else if (!resolveRes.ok) {
      pendingResolveResponse = errorText(RESOLVE_MESSAGES.resolveFailed);
    }
  } else if (adapterIds && !projectId) {
    pendingResolveResponse = rejectText(RESOLVE_MESSAGES.missingProject);
  } else if (isPrivate) {
    pendingResolveResponse = rejectText(RESOLVE_MESSAGES.missingMessageId);
  }

  return { done: false, result: false, pending: pendingResolveResponse };
}
