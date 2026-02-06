import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { handleAskCommand, parseCommand } from "./commands.js";
import { buildIntentHints, escapeRegExp } from "./intent_hints.js";
import { runPipeline, type MatchResult, type PipelineStep } from "./intent_pipeline.js";
import { appendLedger } from "../audit/ledger.js";
import { getStatusFacts } from "./context.js";
import type { RateLimiter } from "../../core/rateLimit/limiter.js";
import { loadAuth, saveAuth } from "../auth/store.js";
import type { ChatMessage } from "../../core/providers/base.js";
import { submitTask } from "../../core/internal_client.js";
import { evaluate } from "../../core/config/index.js";
import type { LoadedConfig } from "../../core/config/types.js";
import { loadProjectRegistry } from "../runtime/project_registry.js";
import { parseAlertText, LocalFsFactsProvider } from "../facts/index.js";
import { routeExplain } from "../explain/router_v1.js";
import { writeExplainTrace, writeExplainFeedback } from "../audit/trace_writer.js";
import { requestIntentResolve, resolveDefaultWindowSpecId, sanitizeRequestId } from "../runtime/intent_router.js";
import { INTENT_SCHEMA_VERSION, INTENT_VERSION, parseDashboardIntent } from "../runtime/intent_schema.js";
import { buildErrorResultRef, buildTextResultRef } from "../runtime/on_demand_mapping.js";
import { clarifyText, errorText, rejectText } from "../runtime/response_templates.js";
import { buildDashboardIntentFromResolve, dispatchDashboardExport, handleAlertFeedbackIntent, handleResolvedChartIntent } from "../runtime/handlers.js";
import { isIntentEnabled } from "../runtime/capabilities.js";
import { postJsonWithAuth } from "../runtime/http_client.js";
import { checkExplainGate } from "./intent_gate.js";
import { getLastAlert, getLastExplainTrace, setLastAlert, setLastExplainTrace } from "./state_cache.js";
import { handleStrategyIfAny } from "../runtime/strategy.js";
import { handleQueryIfAny } from "../runtime/query.js";
import { handleAlertLevelIntent } from "../runtime/alert_level.js";
import { handleCognitiveIfAny, handleCognitiveStatusUpdate } from "../runtime/cognitive.js";

const NEWS_SUMMARY_DEFAULT_CHARS = 200;
const NEWS_SUMMARY_MAX_CHARS = 1200;
const NEWS_QUERY_DEFAULT_LIMIT = 5;
const NEWS_QUERY_MAX_LIMIT = 20;
const FEEDS_QUERY_DEFAULT_LIMIT = 5;
const FEEDS_QUERY_MAX_LIMIT = 20;
const NEWS_ALERT_MARKERS = ["📰 重要新闻监控触发", "重要新闻监控触发"];
const NEWS_SUMMARY_RESULT_CACHE_TTL_SEC = Number(
  process.env.CHAT_GATEWAY_NEWS_SUMMARY_CACHE_TTL_SEC || "600",
);
const NEWS_SUMMARY_CACHE_MAX_ITEMS = parseIntEnv("CHAT_GATEWAY_NEWS_SUMMARY_CACHE_MAX_ITEMS", 500);
const NEWS_SUMMARY_CACHE_CLEANUP_INTERVAL_MS = parseIntEnv(
  "CHAT_GATEWAY_NEWS_SUMMARY_CACHE_CLEANUP_MS",
  60_000,
);
const newsSummaryCache = new Map<string, { summary: string; source: string; items: number | null; ts: number }>();
let newsSummaryCacheLastCleanup = 0;

type AdapterDedupeState = {
  firstTs: number;
  lastTs: number;
  attempt: number;
};

const adapterDedupe = new Map<string, AdapterDedupeState>();
const ADAPTER_DEDUPE_CLEANUP_THRESHOLD = 5000;
const ADAPTER_DEDUPE_CLEANUP_INTERVAL_MS = parseIntEnv("CHAT_GATEWAY_DEDUPE_CLEANUP_MS", 60_000);
let adapterDedupeLastCleanup = 0;

function parseIntEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const val = Number(raw);
  if (!Number.isFinite(val)) return fallback;
  return Math.max(0, Math.floor(val));
}

type IntentMeta = {
  name: string;
  enabledKey?: string;
  disabledMessage?: string;
  allowGroup?: boolean;
  requiresAuth?: boolean;
  groupDenyAction?: "ignore" | "reject";
};

const INTENT_REGISTRY: Record<string, IntentMeta> = {
  alert_strategy: {
    name: "alert_strategy",
    enabledKey: "alert_strategy",
  },
  alert_query: {
    name: "alert_query",
    enabledKey: "alert_query",
  },
  alert_explain: {
    name: "alert_explain",
    enabledKey: "alert_explain",
  },
  news_summary: {
    name: "news_summary",
    enabledKey: "news_summary",
    disabledMessage: "未开放新闻摘要能力。",
  },
  data_feeds_status: {
    name: "data_feeds_status",
    enabledKey: "data_feeds_status",
    disabledMessage: "未开放数据源查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
  },
  data_feeds_asset_status: {
    name: "data_feeds_asset_status",
    enabledKey: "data_feeds_asset_status",
    disabledMessage: "未开放数据源查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
  },
  data_feeds_source_status: {
    name: "data_feeds_source_status",
    enabledKey: "data_feeds_source_status",
    disabledMessage: "未开放数据源查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
  },
  data_feeds_hotspots: {
    name: "data_feeds_hotspots",
    enabledKey: "data_feeds_hotspots",
    disabledMessage: "未开放数据源查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
  },
  data_feeds_ops_summary: {
    name: "data_feeds_ops_summary",
    enabledKey: "data_feeds_ops_summary",
    disabledMessage: "未开放数据源查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
  },
  news_hot: {
    name: "news_hot",
    enabledKey: "news_hot",
    disabledMessage: "未开放新闻查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
  },
  news_refresh: {
    name: "news_refresh",
    enabledKey: "news_refresh",
    disabledMessage: "未开放新闻查询能力。",
    allowGroup: false,
    requiresAuth: true,
    groupDenyAction: "ignore",
  },
};

type ResolveIntentMeta = IntentMeta;

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

type AdapterContext = {
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

function getIntentMeta(name?: string | null): IntentMeta | null {
  if (!name) return null;
  return INTENT_REGISTRY[name] || null;
}

function resolveGroupDenyAction(intent?: string | null): "allow" | "ignore" | "reject" {
  const meta = getIntentMeta(intent);
  if (!meta || meta.allowGroup !== false) return "allow";
  return meta.groupDenyAction || "ignore";
}

function isIntentEnabledByName(name: string): boolean {
  const meta = getIntentMeta(name);
  const key = meta?.enabledKey || name;
  return isIntentEnabled(key);
}

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

type ResolveFlowResult = {
  done: boolean;
  result: boolean;
  pending: string | null;
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

type ResolveResult = Awaited<ReturnType<typeof requestIntentResolve>>;
type AdapterIds = NonNullable<ReturnType<typeof resolveAdapterRequestIds>>;
type ResolvedDashboardIntent = ReturnType<typeof buildDashboardIntentFromResolve>;

type ResolveStepParams = {
  ctx: AdapterContext;
  resolveRes: ResolveResult;
  adapterIds: AdapterIds;
  resolvedIntent: ResolvedDashboardIntent;
  setPending: (text: string) => void;
};

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
          setPending("请回复：记 / 不记");
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
          setPending("请补充记录编号与状态（例如：C-20260130-001 DONE）");
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
          setPending(rejectText("当前仅支持 Telegram 图表导出。"));
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
        if (!await ensureResolveIntentEnabled(ctx, "data_feeds_status")) {
          return { handled: true };
        }
        if (!await ensureResolveIntentAuthorized(ctx, "data_feeds_status")) {
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
          await send(chatId, "请指定资产（例如：ETHUSDT）。");
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
          await send(chatId, "请指定 feed_id（例如：ohlcv_1m）。");
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
        if (!await ensureResolveIntentEnabled(ctx, "data_feeds_hotspots")) {
          return { handled: true };
        }
        if (!await ensureResolveIntentAuthorized(ctx, "data_feeds_hotspots")) {
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
        if (!await ensureResolveIntentEnabled(ctx, "data_feeds_ops_summary")) {
          return { handled: true };
        }
        if (!await ensureResolveIntentAuthorized(ctx, "data_feeds_ops_summary")) {
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
        if (!await ensureResolveIntentEnabled(ctx, "news_hot")) {
          return { handled: true };
        }
        if (!await ensureResolveIntentAuthorized(ctx, "news_hot")) {
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
        if (!await ensureResolveIntentEnabled(ctx, "news_refresh")) {
          return { handled: true };
        }
        if (!await ensureResolveIntentAuthorized(ctx, "news_refresh")) {
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
          await send(chatId, "请先回复一条告警/新闻消息，然后发一句话（如：摘要 200）。");
          return { handled: true };
        }
        if (!isNewsAlert(rawAlert)) {
          await send(chatId, "当前仅支持新闻摘要，请回复新闻告警再发“摘要 200”。");
          return { handled: true };
        }
          const gateResult = await applyExplainGate({
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
            hasReply: Boolean(trimmedReplyText),
            send,
          });
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
          await send(chatId, "请先回复一条告警/新闻消息，然后发一句话（如：解释一下）。");
          return { handled: true };
        }
        if (isNewsAlert(rawAlert)) {
          if (!isIntentEnabledByName("news_summary")) {
            await send(chatId, rejectText("未开放新闻摘要能力。"));
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
          const gateResult = await applyExplainGate({
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
            hasReply: Boolean(trimmedReplyText),
            send,
          });
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

async function runResolveFlow(ctx: AdapterContext): Promise<ResolveFlowResult> {
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
        await send(chatId, rejectText(meta?.disabledMessage || "未开放相关能力。"));
        return { done: true, result: true, pending: null };
      }
    }

    const steps = buildResolveSteps({ ctx, resolveRes, adapterIds, resolvedIntent, setPending });

    const pipelineResult = await runResolvePipeline(ctx, steps);
    if (pipelineResult.handled) {
      return { done: true, result: pipelineResult.result, pending: null };
    }

    if (resolveRes.ok && (resolveRes.needClarify || resolveRes.intent === "unknown")) {
      pendingResolveResponse = clarifyText("我没有理解你的意图，请用一句话明确你要做的事。");
    } else if (!resolveRes.ok) {
      pendingResolveResponse = errorText("当前解析失败，请稍后重试。");
    }
  } else if (adapterIds && !projectId) {
    pendingResolveResponse = rejectText("未配置默认项目，无法解析请求。");
  } else if (isPrivate) {
    pendingResolveResponse = rejectText("请求缺少 messageId/parent_id，无法解析。");
  }

  return { done: false, result: false, pending: pendingResolveResponse };
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

async function sendPendingIfAny(
  pending: string | null,
  send: (chatId: string, text: string) => Promise<void>,
  chatId: string,
): Promise<boolean> {
  if (!pending) return false;
  await send(chatId, pending);
  return true;
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
          await c.send(c.chatId, "请回复一条新闻告警再发送摘要请求。");
        } else {
          await c.send(c.chatId, "请先回复一条告警/新闻消息，然后发一句话（如：解释一下 / 摘要 200）。");
        }
        return { handled: true };
      }

      const isNews = isNewsAlert(rawAlert);
      const summaryIntent = c.summaryRequested || (isNews && c.explainRequested);
      if (!summaryIntent) return { handled: false };

      if (!isNews) {
        await c.send(c.chatId, "当前仅支持新闻摘要，请回复新闻告警再发“摘要 200”。");
        return { handled: true };
      }

      const gateResult = await applyExplainGate({
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
        hasReply: Boolean(c.trimmedReplyText),
        send: c.send,
      });
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
        await c.send(c.chatId, rejectText("未配置默认项目，无法生成摘要。"));
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
        await c.send(c.chatId, rejectText("请求已过期，请重新发起摘要。"));
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

async function runExplainSummaryFlow(
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

const ADAPTER_DEDUPE_WINDOW_SEC = parseIntEnv(
  "DEDUPE_WINDOW_SEC",
  parseIntEnv("CHAT_GATEWAY_DEDUPE_WINDOW_SEC", 60),
);

function cleanupAdapterDedupe(now: number) {
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

function cleanupNewsSummaryCache(now: number) {
  if (now - newsSummaryCacheLastCleanup < NEWS_SUMMARY_CACHE_CLEANUP_INTERVAL_MS
    && newsSummaryCache.size <= NEWS_SUMMARY_CACHE_MAX_ITEMS) {
    return;
  }
  newsSummaryCacheLastCleanup = now;
  const maxAgeMs = Math.max(0, NEWS_SUMMARY_RESULT_CACHE_TTL_SEC) * 1000;
  for (const [key, entry] of newsSummaryCache) {
    if (maxAgeMs > 0 && now - entry.ts > maxAgeMs) {
      newsSummaryCache.delete(key);
    }
  }
  if (newsSummaryCache.size <= NEWS_SUMMARY_CACHE_MAX_ITEMS) return;
  const entries = Array.from(newsSummaryCache.entries());
  entries.sort((a, b) => a[1].ts - b[1].ts);
  const removeCount = Math.max(0, entries.length - NEWS_SUMMARY_CACHE_MAX_ITEMS);
  for (let i = 0; i < removeCount; i += 1) {
    newsSummaryCache.delete(entries[i][0]);
  }
}

function buildDispatchRequestId(requestIdBase: string, attempt: number): string {
  return sanitizeRequestId(`${requestIdBase}:${attempt}`);
}

function resolveAdapterRequestIds(params: {
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
    cleanupAdapterDedupe(now);
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
    cleanupAdapterDedupe(now);
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
  cleanupAdapterDedupe(now);
  return {
    requestIdBase,
    dispatchRequestId: buildDispatchRequestId(requestIdBase, state.attempt),
    attempt: state.attempt,
    expired,
    reused: true,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function taskPrefix(channel: string): string {
  if (channel === "telegram") return "tg";
  if (channel === "feishu") return "fs";
  const clean = channel.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return clean ? clean.slice(0, 12) : "chan";
}

function clip(s: string, n: number) {
  const t = String(s || "");
  return t.length <= n ? t : t.slice(0, n) + "…";
}

function clipToLen(s: string, n: number) {
  const t = String(s || "");
  if (t.length <= n) return t;
  if (n <= 1) return t.slice(0, n);
  return t.slice(0, n - 1) + "…";
}

function isNewsAlert(raw: string): boolean {
  const s = String(raw || "");
  if (!s.trim()) return false;
  if (NEWS_ALERT_MARKERS.some(m => s.includes(m))) return true;
  const hasBullet = s.includes("• ");
  const hasLink = s.includes("链接:");
  if (hasBullet && hasLink && s.includes("新闻")) return true;
  const parsed = parseNewsAlert(s);
  return parsed.items.length > 0;
}

function wantsRetry(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return /(?:^|\s)(retry|重试)(?:$|\s)/i.test(t);
}

function parseSummaryLength(text: string): number | null {
  const t = String(text || "");
  let m = t.match(/(\d{2,4})\s*(字|字符)/);
  if (m) return Number(m[1]);
  m = t.match(/(\d{2,4})/);
  if (m) return Number(m[1]);
  return null;
}

function resolveSummaryLength(text: string): number {
  const n = parseSummaryLength(text);
  if (!Number.isFinite(n)) return NEWS_SUMMARY_DEFAULT_CHARS;
  const safe = Math.max(1, Math.min(NEWS_SUMMARY_MAX_CHARS, Number(n)));
  return safe;
}

function clampLimit(raw: any, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

type NewsItem = {
  title: string;
  published?: string;
  source?: string;
  link?: string;
};

function parseNewsAlert(rawAlert: string): { items: NewsItem[]; facts: string } {
  const lines = String(rawAlert || "").split("\n");
  const items: NewsItem[] = [];
  let cur: NewsItem | null = null;

  const flush = () => {
    if (cur && cur.title) items.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("• ")) {
      flush();
      cur = { title: t.slice(2).trim() };
      continue;
    }
    if (!cur) continue;
    if (t.startsWith("时间:")) {
      cur.published = t.slice(3).trim();
      continue;
    }
    if (t.startsWith("来源:")) {
      cur.source = t.slice(3).trim();
      continue;
    }
    if (t.startsWith("链接:")) {
      cur.link = t.slice(3).trim();
      continue;
    }
  }
  flush();

  if (!items.length) {
    return { items: [], facts: String(rawAlert || "").trim() };
  }

  const facts: string[] = [];
  items.forEach((it, idx) => {
    facts.push(`${idx + 1}) 标题: ${it.title}`);
    if (it.published) facts.push(`   时间: ${it.published}`);
    if (it.source) facts.push(`   来源: ${it.source}`);
  });
  return { items, facts: facts.join("\n") };
}

function buildNewsSummaryPrompt(facts: string, maxChars: number): string {
  return [
    "你是严格的新闻摘要器。",
    "只允许基于给定新闻要点压缩，不得新增事实/因果/推断，不得引用外部信息。",
    `输出一段中文摘要，不超过 ${maxChars} 个中文字符，尽量贴近上限。`,
    "不要标题，不要列表，不要链接。",
    "",
    "新闻要点：",
    facts || "(无)",
  ].join("\n");
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
    if (proj && proj.enabled !== false) return id;
  }
  const ids = Object.keys(projects);
  return ids.length ? ids[0] : null;
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

function resolveIntentMeta(intent?: string | null): ResolveIntentMeta | null {
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
    await ctx.send(ctx.chatId, rejectText("未授权操作"));
    return false;
  }
  return true;
}

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

type OnDemandConfig = { url: string; token: string; projectId?: string | null };

function resolveOnDemandConfigForNews(config?: LoadedConfig): OnDemandConfig {
  const envUrl = String(process.env.CRYPTO_AGENT_ON_DEMAND_URL || "").trim();
  const envToken = String(process.env.CRYPTO_AGENT_ON_DEMAND_TOKEN || "").trim();
  if (envUrl && envToken) return { url: envUrl, token: envToken, projectId: resolveProjectId(config) };

  const registry = loadProjectRegistry();
  const projectId = resolveProjectId(config);
  const proj = projectId ? registry.projects?.[projectId] : undefined;
  const anyProj = proj ?? registry.projects?.crypto_agent ?? null;
  const onDemand = (anyProj as any)?.on_demand ?? {};

  const url = String(
    onDemand.url
      || (anyProj as any)?.on_demand_url
      || envUrl
      || "http://127.0.0.1:8799",
  ).trim();

  const tokenEnv = String(
    onDemand.token_env
      || (anyProj as any)?.on_demand_token_env
      || "",
  ).trim();
  const token = String(
    (tokenEnv ? process.env[tokenEnv] : "")
      || onDemand.token
      || (anyProj as any)?.on_demand_token
      || envToken
      || "",
  ).trim();

  if (!token) throw new Error("missing on-demand token");
  return { url, token, projectId };
}

function resolveOnDemandConfigForFeeds(config?: LoadedConfig): OnDemandConfig {
  return resolveOnDemandConfigForNews(config);
}

function getProject(config?: LoadedConfig) {
  const projectId = resolveProjectId(config);
  if (!projectId) return null;
  const proj = (config?.projects || {})[projectId];
  if (!proj) return null;
  return { projectId, proj };
}

function getPm2Names(config: LoadedConfig | undefined, resourceKey: "pm2_logs" | "pm2_ps"): string[] {
  const p = getProject(config);
  if (!p) return [];
  const res: any = (p.proj as any)?.resources?.[resourceKey];
  const names = Array.isArray(res?.names) ? res.names : [];
  return names.map((n: any) => String(n)).filter(Boolean);
}

async function collectFacts(params: {
  config?: LoadedConfig;
  project_id: string | null;
  symbol?: string | null;
  anchor_ms?: number | null;
}) {
  const { config, project_id, symbol, anchor_ms } = params;
  if (!project_id) return { degraded: true, reason: "project_missing" };

  const anchor = anchor_ms
    ? new Date(anchor_ms).toISOString()
    : new Date().toISOString();
  const projects = config?.projects || {};
  const factsProvider = new LocalFsFactsProvider(projects);
  return factsProvider.buildExplainFacts({
    project_id,
    anchor_ts_utc: anchor,
    symbol: symbol || undefined,
    recent_n: 5,
  });
}

async function buildExplainContext(rawAlert: string, config?: LoadedConfig) {
  const parsedRaw = parseAlertText(rawAlert);
  const parsed = parsedRaw.ok ? parsedRaw : null;
  const projectId = resolveProjectId(config);
  const facts = parsed
    ? await collectFacts({
        config,
        project_id: projectId,
        symbol: parsed.symbol,
        anchor_ms: parsed.anchor_ms,
      })
    : { degraded: true, reason: "parse_failed" };

  const signals = await getSignalsContext(config, 60, parsed?.symbol ?? null);

  return {
    project_id: projectId,
    alert_raw: rawAlert,
    parsed,
    facts,
    signals,
  };
}

function bucketFactor(v?: number | null): string | null {
  if (typeof v !== "number") return null;
  if (v < 2) return "<2";
  if (v < 5) return "2-5";
  if (v < 10) return "5-10";
  return ">=10";
}

function bucketChangePct(v?: number | null): string | null {
  if (typeof v !== "number") return null;
  const a = Math.abs(v);
  if (a < 0.5) return "<0.5";
  if (a < 1) return "0.5-1";
  if (a < 3) return "1-3";
  if (a < 5) return "3-5";
  return ">=5";
}

function summarizeFacts(facts: any) {
  const top1h = facts?.window_1h?.top3 || [];
  const top24h = facts?.window_24h?.top3 || [];
  const recent = facts?.symbol_recent?.items;
  return {
    top3_1h: Array.isArray(top1h) ? top1h : [],
    top3_24h: Array.isArray(top24h) ? top24h : [],
    symbol_recent_count: Array.isArray(recent) ? recent.length : 0,
  };
}

type SignalRow = {
  ts_utc?: string;
  ts?: number | string;
  ts_ms?: number;
  ts_iso?: string;
  symbol?: string;
  kind?: string;
  type?: string;
};

function utcDateStamp(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function resolveSignalsRoot(config?: LoadedConfig): string | null {
  const proj = (config?.projects || {}).crypto_agent as any;
  const root = typeof proj?.root === "string" ? proj.root.trim() : "";
  if (root) return root;
  const env = String(process.env.CRYPTO_AGENT_ROOT || "").trim();
  if (env) return env;
  const cwd = process.cwd();
  if (cwd.includes("chat-gateway")) {
    return path.resolve(cwd, "..", "crypto_agent");
  }
  return cwd;
}

function parseSignalTsMs(row: SignalRow): number | null {
  const ts = row.ts_utc ?? row.ts ?? row.ts_ms ?? row.ts_iso;
  if (typeof ts === "number") {
    return ts < 1_000_000_000_000 ? ts * 1000 : ts;
  }
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

async function readSignalsFile(filePath: string): Promise<SignalRow[]> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const rows: SignalRow[] = [];
    for (const line of content.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        rows.push(JSON.parse(s));
      } catch {
        // ignore malformed lines
      }
    }
    return rows;
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
}

function topCounts(counts: Map<string, number>, n = 3): Array<[string, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function formatTopList(items: Array<[string, number]>): string {
  if (!items.length) return "无";
  return items.map(([k, v]) => `${k}(${v})`).join(", ");
}

function buildSignalsSummary(rows: SignalRow[], startMs: number, endMs: number, symbol?: string | null) {
  let rawCount = 0;
  const dedupEntries = new Map<string, { symbol: string; kind: string }>();

  for (const row of rows) {
    const ms = parseSignalTsMs(row);
    if (!ms) continue;
    if (ms < startMs || ms > endMs) continue;
    rawCount += 1;

    const symbolRaw = String(row.symbol || "").trim();
    const kindRaw = String(row.kind || row.type || "").trim();
    if (!symbolRaw || !kindRaw) continue;

    const symbolKey = symbolRaw.toUpperCase();
    const kindKey = kindRaw;

    const tsKey = typeof row.ts_utc === "string" && row.ts_utc.trim()
      ? row.ts_utc.trim()
      : new Date(ms).toISOString();
    const key = `${symbolKey}|${kindKey}|${tsKey}`;
    if (dedupEntries.has(key)) continue;
    dedupEntries.set(key, { symbol: symbolKey, kind: kindKey });
  }

  const symbolCounts = new Map<string, number>();
  const kindCounts = new Map<string, number>();
  for (const entry of dedupEntries.values()) {
    symbolCounts.set(entry.symbol, (symbolCounts.get(entry.symbol) || 0) + 1);
    kindCounts.set(entry.kind, (kindCounts.get(entry.kind) || 0) + 1);
  }

  const symbolKey = symbol ? String(symbol).trim().toUpperCase() : "";
  const symbolCount = symbolKey ? (symbolCounts.get(symbolKey) || 0) : null;

  return {
    rawCount,
    dedupCount: dedupEntries.size,
    symbolCount,
    topSymbols: topCounts(symbolCounts),
    topKinds: topCounts(kindCounts),
  };
}

async function readSignalsRows(config: LoadedConfig | undefined, minutes: number) {
  const root = resolveSignalsRoot(config);
  if (!root) return { ok: false as const, error: "signals_root_missing" };

  const now = new Date();
  const endMs = now.getTime();
  const startMs = endMs - minutes * 60 * 1000;
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  const baseDir = path.join(root, "data/metrics");
  if (!fs.existsSync(baseDir)) {
    return { ok: false as const, error: "signals_dir_missing" };
  }
  const files = [
    path.join(baseDir, `signals_${utcDateStamp(now)}.jsonl`),
  ];
  if (minutes > nowMinutes) {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    files.push(path.join(baseDir, `signals_${utcDateStamp(yesterday)}.jsonl`));
  }

  const rows: SignalRow[] = [];
  for (const f of files) {
    const chunk = await readSignalsFile(f);
    rows.push(...chunk);
  }

  return { ok: true as const, rows, startMs, endMs };
}

async function getSignalsDigest(config: LoadedConfig | undefined, minutes: number) {
  const res = await readSignalsRows(config, minutes);
  if (!res.ok) return res;
  return {
    ok: true as const,
    summary: buildSignalsSummary(res.rows, res.startMs, res.endMs),
  };
}

function formatSignalsDigest(minutes: number, summary: ReturnType<typeof buildSignalsSummary>) {
  return [
    `🧾 过去 ${minutes}min 行为异常摘要`,
    `- 总计：${summary.rawCount} 条（去重后 ${summary.dedupCount} 条）`,
    `- Top：${formatTopList(summary.topSymbols)}`,
    `- 类型：${formatTopList(summary.topKinds)}`,
  ].join("\n");
}

type SignalsContext = {
  ok: boolean;
  minutes: number;
  symbol?: string | null;
  summary?: ReturnType<typeof buildSignalsSummary>;
  error?: string;
};

async function getSignalsContext(
  config: LoadedConfig | undefined,
  minutes: number,
  symbol?: string | null,
): Promise<SignalsContext> {
  const res = await readSignalsRows(config, minutes);
  if (!res.ok) return { ok: false, minutes, symbol, error: res.error };
  return {
    ok: true,
    minutes,
    symbol,
    summary: buildSignalsSummary(res.rows, res.startMs, res.endMs, symbol),
  };
}

function formatSignalsContext(ctx?: SignalsContext | null): string {
  if (!ctx || !ctx.ok || !ctx.summary) return "";
  const symbolLabel = ctx.symbol ? String(ctx.symbol).toUpperCase() : "unknown";
  const symbolCount = ctx.summary.symbolCount ?? 0;
  return [
    `📈 Signals ${ctx.minutes}m`,
    `- ${symbolLabel}: ${symbolCount} 次`,
    `- Top：${formatTopList(ctx.summary.topSymbols)}`,
    `- 类型：${formatTopList(ctx.summary.topKinds)}`,
  ].join("\n");
}

async function runExplain(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  rawAlert: string;
  send: (chatId: string, text: string) => Promise<void>;
  config?: LoadedConfig;
  channel: string;
  taskIdPrefix: string;
}): Promise<{ ok: boolean; summary: string; errCode: string; latencyMs: number }> {
  const { storageDir, chatId, userId, rawAlert, send, config, channel, taskIdPrefix } = params;
  const t0 = Date.now();
  const ctx = await buildExplainContext(rawAlert, config);
  const signalsNote = formatSignalsContext(ctx.signals);
  const input = { alert_raw: rawAlert, parsed: ctx.parsed, facts: ctx.facts, mode: channel };
  const decision = routeExplain(input);
  const taskId = `${taskIdPrefix}_${chatId}_${Date.now()}`;

  let summary = "";
  let ok = false;
  let errCode = "";
  let latencyMs = 0;

  try {
    const res = await submitTask({
      task_id: taskId,
      stage: "analyze",
      prompt: decision.prompt,
      context: { ...ctx, router: { selected_paths: decision.selected_paths } },
    });

    latencyMs = Number(res?.latency_ms || Date.now() - t0);

    if (!res?.ok) {
      errCode = res?.error || "unknown";
      await send(chatId, errorText(`解释失败：${errCode}`));
    } else {
      ok = true;
      summary = String(res.summary || "");
      if (signalsNote) {
        summary = `${signalsNote}\n\n${summary}`;
      }
      await send(chatId, summary);
    }
  } catch (e: any) {
    latencyMs = Date.now() - t0;
    errCode = String(e?.message || e);
    await send(chatId, errorText(`解释异常：${errCode}`));
  }

  const parsed = ctx.parsed;
  const trace = {
    ts_utc: new Date().toISOString(),
    channel,
    chat_id: chatId,
    user_id: userId,
    project_id: ctx.project_id,
    alert_features: {
      symbol: parsed?.symbol ?? null,
      priority: parsed?.priority ?? null,
      factor_bucket: bucketFactor(parsed?.factor),
      change_pct_bucket: bucketChangePct(parsed?.change_pct),
    },
    facts_summary: summarizeFacts(ctx.facts),
    router: { selected_paths: decision.selected_paths },
    llm: {
      provider: "internal_api",
      model: "unknown",
      latency_ms: latencyMs,
      ok,
      err_code: ok ? undefined : errCode || "unknown",
    },
    output_meta: {
      chars: summary.length,
      truncated: false,
    },
    trace_id: taskId,
  };

  writeExplainTrace(storageDir, trace);
  setLastExplainTrace(chatId, taskId);

  return { ok, summary, errCode, latencyMs };
}

async function runNewsSummary(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  messageId: string;
  replyToId: string;
  rawAlert: string;
  send: (chatId: string, text: string) => Promise<void>;
  channel: string;
  maxChars: number;
  config?: LoadedConfig;
  adapterEntry?: boolean;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
}) {
  const {
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
    adapterEntry,
  } = params;
  const t0 = Date.now();
  const parsed = parseNewsAlert(rawAlert);
  const requestKey = String(messageId || "").trim() || String(replyToId || "").trim();
  if (!requestKey) {
    await send(chatId, rejectText("该平台缺 messageId 且无回复 parent_id，请用回复触发/升级适配"));
    appendLedger(storageDir, {
      ts_utc: nowIso(),
      channel,
      chat_id: chatId,
      user_id: userId,
      cmd: "news_summary_reject",
      reason: "missing_message_id_and_parent_id",
      error_code: "trace_id_missing",
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      raw: rawAlert,
    });
    return;
  }

  const requestIdBase =
    params.requestIdBase || sanitizeRequestId([channel, chatId, requestKey].filter(Boolean).join(":"));
  const attempt = params.attempt && params.attempt > 0 ? params.attempt : 1;
  const requestId = params.requestId || buildDispatchRequestId(requestIdBase, attempt);
  cleanupNewsSummaryCache(Date.now());
  const cached = newsSummaryCache.get(requestId);
  if (cached) {
    const ageMs = Date.now() - cached.ts;
    if (ageMs <= NEWS_SUMMARY_RESULT_CACHE_TTL_SEC * 1000) {
      const clipped = clipToLen(cached.summary, maxChars);
      await send(chatId, clipped);
      const entry: any = {
        ts_utc: nowIso(),
        channel,
        chat_id: chatId,
        user_id: userId,
        cmd: "news_summary",
        request_id: requestId,
        request_id_base: requestIdBase,
        adapter_trace_id: requestIdBase,
        attempt,
        schema_version: INTENT_SCHEMA_VERSION,
        intent_version: INTENT_VERSION,
        trace_id: requestId,
        requested_chars: maxChars,
        output_chars: clipped.length,
        items: cached.items,
        ok: true,
        err: undefined,
        latency_ms: Date.now() - t0,
        source: `cache:${cached.source}`,
        summary_head: clipToLen(clipped, Math.min(240, maxChars)),
      };
      if (adapterEntry) entry.adapter_entry = true;
      const resultRef = buildTextResultRef(clipped);
      entry.result_ref = resultRef.result_ref;
      entry.result_ref_version = resultRef.result_ref_version;
      appendLedger(storageDir, entry);
      return;
    }
    newsSummaryCache.delete(requestId);
  }

  let summary = "";
  let ok = false;
  let errCode = "";
  let latencyMs = 0;
  let source = "agent";
  let agentLatencyMs: number | null = null;
  let llmLatencyMs: number | null = null;
  let agentItems: number | null = null;

  try {
    const cfg = resolveOnDemandConfigForNews(config);
    const timeoutMs = Number(process.env.CHAT_GATEWAY_NEWS_SUMMARY_TIMEOUT_MS || "8000");
    const payload: any = {
      request_id: requestId,
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      max_chars: maxChars,
      items: parsed.items,
    };
    if (!parsed.items.length) payload.raw_alert = rawAlert;
    if (cfg.projectId) payload.target = { project_id: cfg.projectId };

    const tAgent = Date.now();
    const res = await postJsonWithAuth(`${cfg.url}/v1/news_summary`, cfg.token, payload, { timeoutMs });
    agentLatencyMs = Date.now() - tAgent;
    if (res?.ok && res?.summary) {
      summary = String(res.summary || "").trim();
      ok = Boolean(summary);
      source = `agent:${String(res?.source || "unknown")}`;
      agentItems = Number.isFinite(Number(res?.items)) ? Number(res.items) : null;
      latencyMs = agentLatencyMs || Date.now() - t0;
    } else {
      errCode = String(res?.error || "agent_error");
    }
  } catch (e: any) {
    errCode = String(e?.message || e);
  }

  if (!summary) {
    const prompt = buildNewsSummaryPrompt(parsed.facts, maxChars);
    try {
      const tLlm = Date.now();
      const res = await submitTask({
        task_id: requestId,
        stage: "analyze",
        prompt,
        context: {
          news_items: parsed.items,
          raw_alert: rawAlert,
          max_chars: maxChars,
          channel,
        },
      });

      llmLatencyMs = Date.now() - tLlm;
      latencyMs = Number(res?.latency_ms || Date.now() - t0);

      if (!res?.ok) {
        errCode = res?.error || "unknown";
      } else {
        summary = String(res.summary || "").trim();
        ok = Boolean(summary);
        source = "gateway_llm";
      }
    } catch (e: any) {
      latencyMs = Date.now() - t0;
      errCode = String(e?.message || e);
    }
  }

  if (!summary) {
    const fallback = parsed.items.map(it => it.title).filter(Boolean).join("；");
    summary = fallback ? `要点：${fallback}` : "暂无可用摘要。";
    source = "fallback";
  }
  if (!latencyMs) latencyMs = Date.now() - t0;

  const summaryRaw = summary;
  summary = clipToLen(summaryRaw, maxChars);
  await send(chatId, summary);
  newsSummaryCache.set(requestId, {
    summary: summaryRaw,
    source,
    items: agentItems ?? parsed.items.length,
    ts: Date.now(),
  });
  cleanupNewsSummaryCache(Date.now());

  const entry: any = {
    ts_utc: nowIso(),
    channel,
    chat_id: chatId,
    user_id: userId,
    cmd: "news_summary",
    request_id: requestId,
    request_id_base: requestIdBase,
    adapter_trace_id: requestIdBase,
    attempt,
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    requested_chars: maxChars,
    output_chars: summary.length,
    items: agentItems ?? parsed.items.length,
    ok,
    err: ok ? undefined : errCode || "unknown",
    latency_ms: latencyMs,
    trace_id: requestId,
    source,
    agent_latency_ms: agentLatencyMs,
    llm_latency_ms: llmLatencyMs,
    summary_head: clipToLen(summary, Math.min(240, maxChars)),
  };
  if (adapterEntry) entry.adapter_entry = true;
  if (summary) {
    const resultRef = buildTextResultRef(summary);
    entry.result_ref = resultRef.result_ref;
    entry.result_ref_version = resultRef.result_ref_version;
  } else if (errCode) {
    const resultRef = buildErrorResultRef(errCode);
    entry.result_ref = resultRef.result_ref;
    entry.result_ref_version = resultRef.result_ref_version;
  }
  appendLedger(storageDir, entry);
}

type NewsQueryKind = "news_hot" | "news_refresh";

function formatNewsItems(items: any[]): string[] {
  const lines: string[] = [];
  items.forEach((raw, idx) => {
    const title = String(raw?.title || raw?.name || "").trim() || "（无标题）";
    const source = String(raw?.source || raw?.publisher || "").trim();
    const published = String(raw?.published_at || raw?.published || raw?.publishedAt || "").trim();
    const url = String(raw?.url || raw?.link || "").trim();
    lines.push(`${idx + 1}. ${title}`);
    const meta = [source, published].filter(Boolean).join(" | ");
    if (meta) lines.push(`   ${meta}`);
    if (url) lines.push(`   ${url}`);
  });
  return lines;
}

function formatNewsQueryResponse(res: any): string {
  const mode = String(res?.mode || "cached");
  const items = Array.isArray(res?.items) ? res.items : [];
  const lines: string[] = [`新闻热点（mode=${mode}）`];
  if (res?.cooldown_until) lines.push(`冷却至：${res.cooldown_until}`);
  if (res?.last_ts_utc) lines.push(`最近刷新：${res.last_ts_utc}`);
  if (res?.source_count != null) lines.push(`来源数：${res.source_count}`);
  if (!items.length) {
    lines.push("暂无新闻。");
    return lines.join("\n");
  }
  lines.push(...formatNewsItems(items));
  return lines.join("\n");
}

async function runNewsQuery(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  channel: string;
  send: (chatId: string, text: string) => Promise<void>;
  config?: LoadedConfig;
  kind: NewsQueryKind;
  limit?: number | null;
  adapterEntry?: boolean;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
}) {
  const {
    storageDir,
    chatId,
    userId,
    channel,
    send,
    config,
    kind,
    limit,
    adapterEntry,
  } = params;
  const t0 = Date.now();
  const requestIdBase = params.requestIdBase || sanitizeRequestId([channel, chatId, kind, Date.now()].join(":"));
  const attempt = params.attempt && params.attempt > 0 ? params.attempt : 1;
  const requestId = params.requestId || buildDispatchRequestId(requestIdBase, attempt);
  const requestLimit = clampLimit(limit, NEWS_QUERY_DEFAULT_LIMIT, NEWS_QUERY_MAX_LIMIT);
  let ok = false;
  let errCode = "";
  let latencyMs = 0;
  let output = "";
  try {
    const cfg = resolveOnDemandConfigForNews(config);
    const timeoutMs = Number(process.env.CHAT_GATEWAY_NEWS_QUERY_TIMEOUT_MS || "8000");
    const payload: any = {
      request_id: requestId,
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      limit: requestLimit,
    };
    if (cfg.projectId) payload.target = { project_id: cfg.projectId };
    const endpoint = kind === "news_refresh" ? "/v1/news/refresh" : "/v1/news/hot";
    const res = await postJsonWithAuth(`${cfg.url}${endpoint}`, cfg.token, payload, { timeoutMs });
    if (!res?.ok) {
      throw new Error(res?.error || "news_query_failed");
    }
    output = formatNewsQueryResponse(res);
    ok = true;
  } catch (e: any) {
    errCode = String(e?.message || e);
    output = errorText(`新闻查询失败：${errCode}`);
  } finally {
    latencyMs = Date.now() - t0;
  }

  await send(chatId, output);
  const entry: any = {
    ts_utc: nowIso(),
    channel,
    chat_id: chatId,
    user_id: userId,
    cmd: kind,
    request_id: requestId,
    request_id_base: requestIdBase,
    adapter_trace_id: requestIdBase,
    attempt,
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    ok,
    err: ok ? undefined : errCode || "unknown",
    latency_ms: latencyMs,
    limit: requestLimit,
  };
  if (adapterEntry) entry.adapter_entry = true;
  appendLedger(storageDir, entry);
}

function formatFeedSummary(summary: any): string {
  const feeds = summary && typeof summary === "object" ? summary.feeds || {} : {};
  const feedIds = Object.keys(feeds || {}).sort();
  const headerParts: string[] = [];
  if (summary?.health_date) headerParts.push(`health=${summary.health_date}`);
  if (summary?.budget_date) headerParts.push(`budget=${summary.budget_date}`);
  const header = headerParts.length ? `数据源状态（${headerParts.join(", ")}）` : "数据源状态";
  if (!feedIds.length) return `${header}\n暂无数据。`;
  const maxLines = 20;
  const lines: string[] = [header];
  feedIds.slice(0, maxLines).forEach(feedId => {
    const info = feeds[feedId] || {};
    const total = info.symbols_total != null ? String(info.symbols_total) : "-";
    const ok = info.symbols_ok != null ? String(info.symbols_ok) : "-";
    const partial = info.symbols_partial != null ? String(info.symbols_partial) : "0";
    const budgetHit = `${info.budget_hit_hour ? "H" : ""}${info.budget_hit_day ? "D" : ""}`;
    const req = info.requests != null ? String(info.requests) : "";
    const succ = info.success != null ? String(info.success) : "";
    const fail = info.fail != null ? String(info.fail) : "";
    const parts: string[] = [];
    if (total !== "-") parts.push(`ok ${ok}/${total}`);
    if (partial !== "0") parts.push(`partial ${partial}`);
    if (budgetHit) parts.push(`budget=${budgetHit}`);
    if (req || succ || fail) parts.push(`req ${req || "-"} / ok ${succ || "-"} / fail ${fail || "-"}`);
    lines.push(`- ${feedId}: ${parts.join(", ") || "no data"}`);
  });
  if (feedIds.length > maxLines) lines.push(`… 其余 ${feedIds.length - maxLines} 个数据源已省略`);
  return lines.join("\n");
}

function formatAssetStatus(result: any): string {
  const symbol = String(result?.symbol || "").trim();
  const feeds = result && typeof result === "object" ? result.feeds || {} : {};
  const feedIds = Object.keys(feeds || {}).sort();
  const lines: string[] = [`数据源资产状态：${symbol || "未知"}`];
  if (!feedIds.length) {
    lines.push("暂无覆盖记录。");
    return lines.join("\n");
  }
  feedIds.forEach(feedId => {
    const info = feeds[feedId] || {};
    const parts: string[] = [];
    if (info.coverage) parts.push(`coverage=${info.coverage}`);
    if (info.ok != null) parts.push(`ok=${Boolean(info.ok)}`);
    if (info.latency_sec != null) parts.push(`latency=${info.latency_sec}s`);
    if (info.coverage_reason) parts.push(`reason=${info.coverage_reason}`);
    const budget = info.budget || {};
    const hit = `${budget.budget_hit_hour ? "H" : ""}${budget.budget_hit_day ? "D" : ""}`;
    if (hit) parts.push(`budget=${hit}`);
    if (budget.requests != null || budget.success != null || budget.fail != null) {
      parts.push(`req ${budget.requests ?? "-"} / ok ${budget.success ?? "-"} / fail ${budget.fail ?? "-"}`);
    }
    lines.push(`- ${feedId}: ${parts.join(", ") || "no data"}`);
  });
  return lines.join("\n");
}

function formatSourceStatus(result: any): string {
  const feedId = String(result?.feed_id || "").trim();
  const health = result?.health || {};
  const budget = result?.budget || {};
  const symbols = health?.symbols && typeof health.symbols === "object" ? health.symbols : {};
  const symbolIds = Object.keys(symbols || {});
  let ok = 0;
  let partial = 0;
  symbolIds.forEach(sym => {
    const s = symbols[sym];
    if (!s || typeof s !== "object") return;
    if (s.coverage === "partial") partial += 1;
    if (s.ok) ok += 1;
  });
  const lines: string[] = [`数据源状态：${feedId || "未知"}`];
  if (symbolIds.length) {
    lines.push(`symbols：ok ${ok}/${symbolIds.length}，partial ${partial}`);
  }
  if (budget && typeof budget === "object") {
    const hit = `${budget.budget_hit_hour ? "H" : ""}${budget.budget_hit_day ? "D" : ""}`;
    if (hit) lines.push(`budget：${hit} 命中`);
    if (budget.requests != null || budget.success != null || budget.fail != null) {
      lines.push(`requests：${budget.requests ?? "-"} / ok ${budget.success ?? "-"} / fail ${budget.fail ?? "-"}`);
    }
  }
  return lines.join("\n");
}

function formatFeedHotspots(hotspots: any[]): string {
  if (!hotspots.length) return "数据源异常：暂无异常。";
  const lines: string[] = [`数据源异常列表（Top ${hotspots.length}）:`];
  hotspots.forEach(item => {
    const kind = String(item?.kind || "");
    const feedId = String(item?.feed_id || "");
    if (kind === "coverage") {
      const symbol = String(item?.symbol || "");
      const coverage = item?.coverage ? String(item.coverage) : "unknown";
      const reason = item?.reason ? String(item.reason) : "";
      const latency = item?.latency_sec != null ? `${item.latency_sec}s` : "";
      const parts = [coverage, reason, latency].filter(Boolean).join(", ");
      lines.push(`- 覆盖异常：${feedId} ${symbol}${parts ? `（${parts}）` : ""}`);
    } else if (kind === "budget") {
      const hit = `${item?.budget_hit_hour ? "H" : ""}${item?.budget_hit_day ? "D" : ""}` || "budget";
      const req = item?.requests != null ? `requests=${item.requests}` : "";
      lines.push(`- 预算命中：${feedId}（${hit}）${req ? ` ${req}` : ""}`);
    } else {
      lines.push(`- ${kind || "unknown"}: ${feedId}`);
    }
  });
  return lines.join("\n");
}

async function runDataFeedsStatus(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  channel: string;
  send: (chatId: string, text: string) => Promise<void>;
  config?: LoadedConfig;
  adapterEntry?: boolean;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
}) {
  const { storageDir, chatId, userId, channel, send, config, adapterEntry } = params;
  const t0 = Date.now();
  const requestIdBase = params.requestIdBase || sanitizeRequestId([channel, chatId, "feeds_status", Date.now()].join(":"));
  const attempt = params.attempt && params.attempt > 0 ? params.attempt : 1;
  const requestId = params.requestId || buildDispatchRequestId(requestIdBase, attempt);
  let ok = false;
  let errCode = "";
  let latencyMs = 0;
  let output = "";
  try {
    const cfg = resolveOnDemandConfigForFeeds(config);
    const timeoutMs = Number(process.env.CHAT_GATEWAY_FEEDS_QUERY_TIMEOUT_MS || "8000");
    const payload: any = { request_id: requestId, schema_version: INTENT_SCHEMA_VERSION, intent_version: INTENT_VERSION };
    const res = await postJsonWithAuth(`${cfg.url}/v1/data_feeds/status`, cfg.token, payload, { timeoutMs });
    if (!res?.ok) throw new Error(res?.error || "feeds_status_failed");
    output = formatFeedSummary(res.summary || {});
    ok = true;
  } catch (e: any) {
    errCode = String(e?.message || e);
    output = errorText(`数据源状态获取失败：${errCode}`);
  } finally {
    latencyMs = Date.now() - t0;
  }
  await send(chatId, output);
  const entry: any = {
    ts_utc: nowIso(),
    channel,
    chat_id: chatId,
    user_id: userId,
    cmd: "data_feeds_status",
    request_id: requestId,
    request_id_base: requestIdBase,
    adapter_trace_id: requestIdBase,
    attempt,
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    ok,
    err: ok ? undefined : errCode || "unknown",
    latency_ms: latencyMs,
  };
  if (adapterEntry) entry.adapter_entry = true;
  appendLedger(storageDir, entry);
}

async function runDataFeedsAssetStatus(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  channel: string;
  send: (chatId: string, text: string) => Promise<void>;
  config?: LoadedConfig;
  symbol: string;
  adapterEntry?: boolean;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
}) {
  const { storageDir, chatId, userId, channel, send, config, symbol, adapterEntry } = params;
  const t0 = Date.now();
  const requestIdBase = params.requestIdBase || sanitizeRequestId([channel, chatId, "feeds_asset", Date.now()].join(":"));
  const attempt = params.attempt && params.attempt > 0 ? params.attempt : 1;
  const requestId = params.requestId || buildDispatchRequestId(requestIdBase, attempt);
  let ok = false;
  let errCode = "";
  let latencyMs = 0;
  let output = "";
  try {
    const cfg = resolveOnDemandConfigForFeeds(config);
    const timeoutMs = Number(process.env.CHAT_GATEWAY_FEEDS_QUERY_TIMEOUT_MS || "8000");
    const payload: any = {
      request_id: requestId,
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      symbol,
    };
    const res = await postJsonWithAuth(`${cfg.url}/v1/data_feeds/asset_status`, cfg.token, payload, { timeoutMs });
    if (!res?.ok) throw new Error(res?.error || "feeds_asset_status_failed");
    output = formatAssetStatus(res.result || {});
    ok = true;
  } catch (e: any) {
    errCode = String(e?.message || e);
    output = errorText(`数据源资产状态获取失败：${errCode}`);
  } finally {
    latencyMs = Date.now() - t0;
  }
  await send(chatId, output);
  const entry: any = {
    ts_utc: nowIso(),
    channel,
    chat_id: chatId,
    user_id: userId,
    cmd: "data_feeds_asset_status",
    request_id: requestId,
    request_id_base: requestIdBase,
    adapter_trace_id: requestIdBase,
    attempt,
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    ok,
    err: ok ? undefined : errCode || "unknown",
    latency_ms: latencyMs,
    symbol,
  };
  if (adapterEntry) entry.adapter_entry = true;
  appendLedger(storageDir, entry);
}

async function runDataFeedsSourceStatus(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  channel: string;
  send: (chatId: string, text: string) => Promise<void>;
  config?: LoadedConfig;
  feedId: string;
  adapterEntry?: boolean;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
}) {
  const { storageDir, chatId, userId, channel, send, config, feedId, adapterEntry } = params;
  const t0 = Date.now();
  const requestIdBase = params.requestIdBase || sanitizeRequestId([channel, chatId, "feeds_source", Date.now()].join(":"));
  const attempt = params.attempt && params.attempt > 0 ? params.attempt : 1;
  const requestId = params.requestId || buildDispatchRequestId(requestIdBase, attempt);
  let ok = false;
  let errCode = "";
  let latencyMs = 0;
  let output = "";
  try {
    const cfg = resolveOnDemandConfigForFeeds(config);
    const timeoutMs = Number(process.env.CHAT_GATEWAY_FEEDS_QUERY_TIMEOUT_MS || "8000");
    const payload: any = {
      request_id: requestId,
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      feed_id: feedId,
    };
    const res = await postJsonWithAuth(`${cfg.url}/v1/data_feeds/source_status`, cfg.token, payload, { timeoutMs });
    if (!res?.ok) throw new Error(res?.error || "feeds_source_status_failed");
    output = formatSourceStatus(res.result || {});
    ok = true;
  } catch (e: any) {
    errCode = String(e?.message || e);
    output = errorText(`数据源状态获取失败：${errCode}`);
  } finally {
    latencyMs = Date.now() - t0;
  }
  await send(chatId, output);
  const entry: any = {
    ts_utc: nowIso(),
    channel,
    chat_id: chatId,
    user_id: userId,
    cmd: "data_feeds_source_status",
    request_id: requestId,
    request_id_base: requestIdBase,
    adapter_trace_id: requestIdBase,
    attempt,
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    ok,
    err: ok ? undefined : errCode || "unknown",
    latency_ms: latencyMs,
    feed_id: feedId,
  };
  if (adapterEntry) entry.adapter_entry = true;
  appendLedger(storageDir, entry);
}

async function runDataFeedsHotspots(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  channel: string;
  send: (chatId: string, text: string) => Promise<void>;
  config?: LoadedConfig;
  limit?: number | null;
  adapterEntry?: boolean;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
}) {
  const { storageDir, chatId, userId, channel, send, config, limit, adapterEntry } = params;
  const t0 = Date.now();
  const requestIdBase = params.requestIdBase || sanitizeRequestId([channel, chatId, "feeds_hotspots", Date.now()].join(":"));
  const attempt = params.attempt && params.attempt > 0 ? params.attempt : 1;
  const requestId = params.requestId || buildDispatchRequestId(requestIdBase, attempt);
  const requestLimit = clampLimit(limit, FEEDS_QUERY_DEFAULT_LIMIT, FEEDS_QUERY_MAX_LIMIT);
  let ok = false;
  let errCode = "";
  let latencyMs = 0;
  let output = "";
  try {
    const cfg = resolveOnDemandConfigForFeeds(config);
    const timeoutMs = Number(process.env.CHAT_GATEWAY_FEEDS_QUERY_TIMEOUT_MS || "8000");
    const payload: any = {
      request_id: requestId,
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      limit: requestLimit,
    };
    const res = await postJsonWithAuth(`${cfg.url}/v1/data_feeds/hotspots`, cfg.token, payload, { timeoutMs });
    if (!res?.ok) throw new Error(res?.error || "feeds_hotspots_failed");
    output = formatFeedHotspots(Array.isArray(res.hotspots) ? res.hotspots : []);
    ok = true;
  } catch (e: any) {
    errCode = String(e?.message || e);
    output = errorText(`数据源异常列表获取失败：${errCode}`);
  } finally {
    latencyMs = Date.now() - t0;
  }
  await send(chatId, output);
  const entry: any = {
    ts_utc: nowIso(),
    channel,
    chat_id: chatId,
    user_id: userId,
    cmd: "data_feeds_hotspots",
    request_id: requestId,
    request_id_base: requestIdBase,
    adapter_trace_id: requestIdBase,
    attempt,
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    ok,
    err: ok ? undefined : errCode || "unknown",
    latency_ms: latencyMs,
    limit: requestLimit,
  };
  if (adapterEntry) entry.adapter_entry = true;
  appendLedger(storageDir, entry);
}

async function runDataFeedsOpsSummary(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  channel: string;
  send: (chatId: string, text: string) => Promise<void>;
  config?: LoadedConfig;
  limit?: number | null;
  adapterEntry?: boolean;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
}) {
  const { storageDir, chatId, userId, channel, send, config, limit, adapterEntry } = params;
  const t0 = Date.now();
  const requestIdBase = params.requestIdBase || sanitizeRequestId([channel, chatId, "feeds_ops", Date.now()].join(":"));
  const attempt = params.attempt && params.attempt > 0 ? params.attempt : 1;
  const requestId = params.requestId || buildDispatchRequestId(requestIdBase, attempt);
  const requestLimit = clampLimit(limit, FEEDS_QUERY_DEFAULT_LIMIT, FEEDS_QUERY_MAX_LIMIT);
  let ok = false;
  let errCode = "";
  let latencyMs = 0;
  let output = "";
  try {
    const cfg = resolveOnDemandConfigForFeeds(config);
    const timeoutMs = Number(process.env.CHAT_GATEWAY_FEEDS_QUERY_TIMEOUT_MS || "8000");
    const payload: any = {
      request_id: requestId,
      schema_version: INTENT_SCHEMA_VERSION,
      intent_version: INTENT_VERSION,
      limit: requestLimit,
    };
    const res = await postJsonWithAuth(`${cfg.url}/v1/data_feeds/ops_summary`, cfg.token, payload, { timeoutMs });
    if (!res?.ok) throw new Error(res?.error || "feeds_ops_summary_failed");
    const summary = String(res?.summary || "").trim();
    if (summary) {
      output = summary;
    } else {
      output = formatFeedHotspots(Array.isArray(res.hotspots) ? res.hotspots : []);
    }
    ok = true;
  } catch (e: any) {
    errCode = String(e?.message || e);
    output = errorText(`数据源运维摘要获取失败：${errCode}`);
  } finally {
    latencyMs = Date.now() - t0;
  }
  await send(chatId, output);
  const entry: any = {
    ts_utc: nowIso(),
    channel,
    chat_id: chatId,
    user_id: userId,
    cmd: "data_feeds_ops_summary",
    request_id: requestId,
    request_id_base: requestIdBase,
    adapter_trace_id: requestIdBase,
    attempt,
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    ok,
    err: ok ? undefined : errCode || "unknown",
    latency_ms: latencyMs,
    limit: requestLimit,
  };
  if (adapterEntry) entry.adapter_entry = true;
  appendLedger(storageDir, entry);
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
      await send(chatId, "请回复一条告警/新闻消息再 @我。");
    } else {
      await send(chatId, "请先回复一条告警/新闻消息，然后发一句话（如：解释一下）。");
    }
    return true;
  }

  if (isNewsAlert(rawAlert)) {
    return false;
  }

  const gateResult = await applyExplainGate({
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
    hasReply: Boolean(replyText),
    send,
  });
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
    await send(chatId, rejectText("请求已过期，请重新发起解释。"));
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

function formatAnalyzeReply(out: string): string {
  // Keep it TG-friendly. Facts-only.
  return [
    "🧠 DeepSeek Analysis (facts-only)",
    "",
    clip(out, 3500),
  ].join("\n");
}

type SuggestObj = {
  summary?: string;
  suggested_patch?: string;
  files_touched?: string[];
  verify_cmds?: string[];
  warnings?: string[];
};

type SendFn = (chatId: string, text: string) => Promise<void>;

function summarizePatch(patch: string): string {
  const p = String(patch || "").trim();
  if (!p) return "(none)";
  // show only first ~20 lines
  const lines = p.split("\n").slice(0, 20);
  return lines.join("\n") + (p.split("\n").length > 20 ? "\n…" : "");
}

function formatSuggestReply(obj: SuggestObj): string {
  const summary = clip(String(obj.summary || ""), 800);
  const files = (obj.files_touched || []).slice(0, 8).map(s => `- ${s}`).join("\n") || "(none)";
  const cmds = (obj.verify_cmds || []).slice(0, 8).map(s => `- ${s}`).join("\n") || "(none)";
  const warns = (obj.warnings || []).slice(0, 6).map(s => `- ${s}`).join("\n") || "(none)";
  const patchHead = summarizePatch(String(obj.suggested_patch || ""));

  // IMPORTANT: do not spam huge patch into TG
  return [
    "🛠 DeepSeek Suggestion (facts-only)",
    "",
    "Summary:",
    summary || "(none)",
    "",
    "Files touched:",
    files,
    "",
    "Verify cmds:",
    cmds,
    "",
    "Warnings:",
    warns,
    "",
    "Patch (preview only, not applied):",
    "```",
    clip(patchHead, 1200),
    "```",
  ].join("\n");
}

function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function buildAnalyzeMessages(q: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a rigorous engineering assistant. Facts-only.\n" +
        "Given the user's incident description, produce:\n" +
        "1) Most likely root cause based on evidence\n" +
        "2) Concrete next-step actions (commands/files)\n" +
        "No speculation. If insufficient evidence, say what's missing.\n",
    },
    { role: "user", content: q },
  ];
}

function buildSuggestMessages(q: string): ChatMessage[] {
  // STRICT JSON output for machine use
  const schema = {
    summary: "string",
    suggested_patch: "string (FULL git diff starting with diff --git, or empty)",
    files_touched: "string[] (repo-relative paths only)",
    verify_cmds: "string[] (repo-relative commands)",
    warnings: "string[]",
  };

  return [
    {
      role: "system",
      content:
        "You are a rigorous engineering assistant. Facts-only.\n" +
        "Return STRICT JSON only. No markdown. No code fences.\n" +
        "Schema:\n" +
        JSON.stringify(schema, null, 2) +
        "\nRules:\n" +
        "- If you output a patch, it MUST start with 'diff --git'.\n" +
        "- files_touched must be repo-relative (no /srv paths).\n" +
        "- If you cannot confidently propose a patch, set suggested_patch=\"\" and explain in warnings.\n",
    },
    { role: "user", content: q },
  ];
}

type OpsLimits = {
  maxLinesDefault: number;
  maxLogChars: number;
  telegramSafeMax: number;
};

function getOpsLimits(): OpsLimits {
  const telegramSafeMax = 3500;
  const maxLinesDefault = Number(process.env.GW_MAX_LOG_LINES || 200);
  const maxLogChars = Math.min(
    Number(process.env.GW_MAX_LOG_CHARS || telegramSafeMax),
    telegramSafeMax,
  );
  return { maxLinesDefault, maxLogChars, telegramSafeMax };
}

function getMaxWindowMinutes(): number {
  const raw = Number(process.env.MAX_WINDOW_MINUTES || 1440);
  if (!Number.isFinite(raw) || raw <= 0) return 1440;
  return Math.floor(raw);
}

function clampLines(n: number, maxLinesDefault: number) {
  if (!Number.isFinite(n) || n <= 0) return 80;
  return Math.min(Math.max(1, Math.floor(n)), maxLinesDefault);
}

function pm2Jlist(): any[] {
  try {
    const out = execSync("pm2 jlist", { encoding: "utf-8" });
    return JSON.parse(out);
  } catch {
    return [];
  }
}

function fmtUptime(ms: number) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d${h % 24}h`;
  if (h > 0) return `${h}h${m % 60}m`;
  return `${m}m`;
}

function renderPs(allowedNames: string[]) {
  const now = Date.now();
  const rows = pm2Jlist()
    .filter((p) => !allowedNames.length || allowedNames.includes(p?.name))
    .map((p) => {
      const name = p?.name || "unknown";
      const status = p?.pm2_env?.status || "unknown";
      const restarts = p?.pm2_env?.restart_time ?? 0;
      const pmUptime = p?.pm2_env?.pm_uptime ?? 0;
      const uptime = pmUptime ? fmtUptime(now - pmUptime) : "—";
      const memMb = p?.monit?.memory ? (p.monit.memory / (1024 * 1024)).toFixed(1) : "0.0";
      const cpu = p?.monit?.cpu ?? 0;
      return { name, status, uptime, restarts, memMb, cpu };
    });

  const lines: string[] = [];
  lines.push("🧾 pm2 (facts-only)");
  if (!rows.length) {
    lines.push("- (no pm2 data)");
  }
  for (const r of rows) {
    lines.push(`- ${r.name}: ${r.status} | up ${r.uptime} | restarts ${r.restarts} | mem ${r.memMb}MB | cpu ${r.cpu}%`);
  }
  return lines.join("\n");
}

function renderStatus(allowedNames: string[]) {
  const nowUtc = new Date().toISOString();
  let sha = "unknown";
  try {
    sha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {}

  const procs = pm2Jlist();
  const byName = new Map<string, any>();
  for (const p of procs) byName.set(p?.name, p);
  const pick = (name: string) => {
    const p = byName.get(name);
    const st = p?.pm2_env?.status || "unknown";
    return `${name}=${st}`;
  };

  const names = allowedNames.length ? allowedNames : [];
  const pm2Line = names.length
    ? names.map((n) => pick(n)).join(" ")
    : "(no pm2 names configured)";
  const bits = [
    `✅ status (facts-only)`,
    `- time_utc: ${nowUtc}`,
    `- repo_sha: ${sha}`,
    `- pm2: ${pm2Line}`,
  ];
  return bits.join("\n");
}

function resolvePm2LogPath(name: string, stream: "out" | "error") {
  const base = path.join(os.homedir(), ".pm2", "logs");
  return path.join(base, `${name}-${stream}.log`);
}

function tailFile(filePath: string, n: number): string {
  const cmd = `tail -n ${n} ${filePath.replace(/(["\\$`])/g, "\\$1")}`;
  return execSync(cmd, { encoding: "utf-8" });
}

function renderLogs(name: string, lines: number, maxLinesDefault: number) {
  const n = clampLines(lines, maxLinesDefault);
  const outPath = resolvePm2LogPath(name, "out");
  const errPath = resolvePm2LogPath(name, "error");
  const chunks: string[] = [];
  chunks.push(`📜 logs: ${name} (last ${n})`);

  if (fs.existsSync(errPath)) {
    try {
      const t = tailFile(errPath, n).trimEnd();
      if (t) {
        chunks.push("--- error ---");
        chunks.push(t);
      }
    } catch {}
  }
  if (fs.existsSync(outPath)) {
    try {
      const t = tailFile(outPath, n).trimEnd();
      if (t) {
        chunks.push("--- out ---");
        chunks.push(t);
      }
    } catch {}
  }

  if (chunks.length <= 1) {
    return `⚠️ logs unavailable: no pm2 log files for '${name}'`;
  }
  return chunks.join("\n");
}

async function handleOpsCommand(params: {
  storageDir: string;
  channel: string;
  cleanedText: string;
  config?: LoadedConfig;
  chatId: string;
  userId: string;
  mentionsBot: boolean;
  trimmedReplyText: string;
  isGroup: boolean;
  allowed: boolean;
  send: SendFn;
}): Promise<boolean> {
  const {
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
  } = params;

  if (!cleanedText.startsWith("/status") && !cleanedText.startsWith("/ps") && !cleanedText.startsWith("/logs")) {
    return false;
  }

  const { maxLinesDefault, maxLogChars, telegramSafeMax } = getOpsLimits();
  const pm2LogsNames = getPm2Names(config, "pm2_logs");
  const pm2PsNames = getPm2Names(config, "pm2_ps");
  const chatType = isGroup ? "group" : "private";
  const policyOk = config?.meta?.policyOk === true;
  const evalOps = (capability: string) => evaluate(config, {
    channel,
    capability,
    chat_id: chatId,
    chat_type: chatType,
    user_id: userId,
    mention_bot: mentionsBot,
    has_reply: Boolean(trimmedReplyText),
  });

  if (cleanedText.startsWith("/status")) {
    const res = evalOps("ops.status");
    if (res.require?.mention_bot_for_ops && !mentionsBot) return true;
    const isAllowed = policyOk ? res.allowed : allowed;
    if (!isAllowed) {
      await send(chatId, res.deny_message || rejectText("未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。"));
      return true;
    }
    const status = renderStatus(pm2PsNames);
    const feedback = getStatusFacts(storageDir).split("\n").slice(1);
    const out = feedback.length ? `${status}\n${feedback.join("\n")}` : status;
    await send(chatId, out);
    return true;
  }

  if (cleanedText.startsWith("/ps")) {
    const res = evalOps("ops.ps");
    if (res.require?.mention_bot_for_ops && !mentionsBot) return true;
    const isAllowed = policyOk ? res.allowed : allowed;
    if (!isAllowed) {
      await send(chatId, res.deny_message || rejectText("未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。"));
      return true;
    }
    await send(chatId, renderPs(pm2PsNames));
    return true;
  }

  if (cleanedText.startsWith("/logs")) {
    const res = evalOps("ops.logs");
    if (res.require?.mention_bot_for_ops && !mentionsBot) return true;
    const isAllowed = policyOk ? res.allowed : allowed;
    if (!isAllowed) {
      await send(chatId, res.deny_message || rejectText("未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。"));
      return true;
    }
    const parts = cleanedText.split(/\s+/).filter(Boolean);
    if (!pm2LogsNames.length) {
      await send(chatId, "⚠️ 未配置 pm2 日志进程名（manifest: pm2_logs.names）。");
      return true;
    }
    const name = parts[1] || pm2LogsNames[0];
    if (!pm2LogsNames.includes(name)) {
      await send(chatId, `⚠️ 不允许的进程名：${name}`);
      return true;
    }
    const lines = parts[2] ? Number(parts[2]) : 80;
    const out = renderLogs(name, lines, maxLinesDefault);
    if (out.length > maxLogChars) {
      const head = out.slice(0, Math.max(0, maxLogChars - 40));
      const msg =
        `⚠️ 输出过长，已截断到 ${maxLogChars} 字符（上限 ${telegramSafeMax}）。\n` +
        head +
        "\n...(clipped)";
      await send(chatId, msg);
      return true;
    }
    await send(chatId, out);
    return true;
  }

  return false;
}

async function handlePrivateMessage(params: {
  channel: string;
  taskIdPrefix: string;
  storageDir: string;
  chatId: string;
  userId: string;
  messageId: string;
  replyToId: string;
  trimmedText: string;
  trimmedReplyText: string;
  isCommand: boolean;
  send: SendFn;
  config?: LoadedConfig;
}): Promise<boolean> {
  const {
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
  } = params;

  if (trimmedReplyText) {
    setLastAlert(storageDir, chatId, trimmedReplyText);
  }

  if (trimmedText === "/help" || trimmedText === "help") {
    await send(chatId, "用法：回复一条告警发“解释一下”；回复新闻发“摘要 200”。");
    return true;
  }

  if (!isCommand) {
    return false;
  }

  return false;
}

async function handleParsedCommand(params: {
  cmd: ReturnType<typeof parseCommand>;
  channel: string;
  taskIdPrefix: string;
  storageDir: string;
  chatId: string;
  userId: string;
  text: string;
  isOwner: boolean;
  authState: ReturnType<typeof loadAuth>;
  send: SendFn;
  config?: LoadedConfig;
}) {
  const { cmd, channel, taskIdPrefix, storageDir, chatId, userId, text, isOwner, authState, send, config } = params;

  // auth commands only owner
  if (cmd.kind.startsWith("auth_") && !isOwner) {
    await send(chatId, rejectText("permission denied"));
    return;
  }

  const ts = nowIso();
  const baseAudit = { ts_utc: ts, channel, chat_id: chatId, user_id: userId, raw: text };

  if (cmd.kind === "help") {
    const out = [
      "/help",
      "/status",
      "/signals [N]m|[N]h",
      "/news [N]",
      "/news refresh [N]",
      "/feeds status",
      "/feeds asset <SYMBOL>",
      "/feeds source <feed_id>",
      "/feeds hotspots [N]",
      "/feeds ops [N]",
      "/ask <q>",
      "/analyze <incident description>",
      "/suggest <incident description>",
      "/auth add <chat_id>",
      "/auth del <chat_id>",
      "/auth list",
      "/feedback <描述>（例如：告警太多了 / 告警太少了）",
    ].join("\n");
    await send(chatId, out);
    appendLedger(storageDir, { ...baseAudit, cmd: "help" });
    return;

  } else if (cmd.kind === "news_hot") {
    if (!isIntentEnabled("news_hot")) {
      await send(chatId, rejectText("未开放新闻查询能力。"));
      return;
    }
    await runNewsQuery({
      storageDir,
      chatId,
      userId,
      channel,
      send,
      config,
      kind: "news_hot",
      limit: cmd.limit,
    });
    return;

  } else if (cmd.kind === "news_refresh") {
    if (!isIntentEnabled("news_refresh")) {
      await send(chatId, rejectText("未开放新闻查询能力。"));
      return;
    }
    await runNewsQuery({
      storageDir,
      chatId,
      userId,
      channel,
      send,
      config,
      kind: "news_refresh",
      limit: cmd.limit,
    });
    return;

  } else if (cmd.kind === "feeds_status") {
    if (!isIntentEnabled("data_feeds_status")) {
      await send(chatId, rejectText("未开放数据源查询能力。"));
      return;
    }
    await runDataFeedsStatus({
      storageDir,
      chatId,
      userId,
      channel,
      send,
      config,
    });
    return;

  } else if (cmd.kind === "feeds_asset") {
    if (!isIntentEnabled("data_feeds_asset_status")) {
      await send(chatId, rejectText("未开放数据源查询能力。"));
      return;
    }
    const symbol = String(cmd.symbol || "").trim();
    if (!symbol) {
      await send(chatId, "Usage: /feeds asset <SYMBOL>");
      return;
    }
    await runDataFeedsAssetStatus({
      storageDir,
      chatId,
      userId,
      channel,
      send,
      config,
      symbol,
    });
    return;

  } else if (cmd.kind === "feeds_source") {
    if (!isIntentEnabled("data_feeds_source_status")) {
      await send(chatId, rejectText("未开放数据源查询能力。"));
      return;
    }
    const feedId = String(cmd.feedId || "").trim();
    if (!feedId) {
      await send(chatId, "Usage: /feeds source <feed_id>");
      return;
    }
    await runDataFeedsSourceStatus({
      storageDir,
      chatId,
      userId,
      channel,
      send,
      config,
      feedId,
    });
    return;

  } else if (cmd.kind === "feeds_hotspots") {
    if (!isIntentEnabled("data_feeds_hotspots")) {
      await send(chatId, rejectText("未开放数据源查询能力。"));
      return;
    }
    await runDataFeedsHotspots({
      storageDir,
      chatId,
      userId,
      channel,
      send,
      config,
      limit: cmd.limit,
    });
    return;

  } else if (cmd.kind === "feeds_ops") {
    if (!isIntentEnabled("data_feeds_ops_summary")) {
      await send(chatId, rejectText("未开放数据源查询能力。"));
      return;
    }
    await runDataFeedsOpsSummary({
      storageDir,
      chatId,
      userId,
      channel,
      send,
      config,
      limit: cmd.limit,
    });
    return;

  } else if (cmd.kind === "signals") {
    const maxWindow = getMaxWindowMinutes();
    if (!cmd.minutes) {
      await send(chatId, `Usage: /signals [N]m|[N]h (default 60m, max ${maxWindow}m)`);
      return;
    }
    if (cmd.minutes > maxWindow) {
      await send(chatId, `Window too large. Max ${maxWindow}m.`);
      return;
    }

    try {
      const digest = await getSignalsDigest(config, cmd.minutes);
      if (!digest.ok) {
        const msg = digest.error === "signals_dir_missing"
          ? "signals data dir missing"
          : "signals source not configured";
        await send(chatId, errorText(msg));
        return;
      }

      const out = formatSignalsDigest(cmd.minutes, digest.summary);
      await send(chatId, out);
      appendLedger(storageDir, {
        ...baseAudit,
        cmd: "signals",
        minutes: cmd.minutes,
        raw_count: digest.summary.rawCount,
        dedup_count: digest.summary.dedupCount,
        top_symbols: digest.summary.topSymbols,
        top_kinds: digest.summary.topKinds,
      });
    } catch (e: any) {
      await send(chatId, errorText(`signals read failed: ${String(e?.message || e)}`));
    }
    return;

  } else if (cmd.kind === "ask") {
    await handleAskCommand({
      chatId,
      channel,
      taskIdPrefix,
      text: cmd.q,
      reply: (m) => send(chatId, m),
    });
    appendLedger(storageDir, { ...baseAudit, cmd: "ask" });
    return;

  } else if (cmd.kind === "analyze") {
    const prompt = (cmd.q || "").trim();
    if (!prompt) {
      await send(chatId, "Usage: /analyze <incident description>");
      return;
    }

    const taskId = `${taskIdPrefix}_analyze_${chatId}_${Date.now()}`;

    try {
      const res = await submitTask({
        task_id: taskId,
        stage: "analyze",
        prompt,
        context: {
          source: channel,
          chat_id: chatId,
          user_id: userId,
        },
      });

      if (!res?.ok) {
        await send(chatId, errorText(`Gateway error: ${res?.error || "unknown"}`));
        appendLedger(storageDir, { ...baseAudit, cmd: "analyze", taskId, ok: false, error: res?.error || "unknown" });
        return;
      }

      await send(chatId, `🧠 Analysis (facts-only)\n\n${res.summary}`);
    } catch (e: any) {
      await send(chatId, errorText(`analyze failed: ${String(e?.message || e)}`));
    }

    appendLedger(storageDir, { ...baseAudit, cmd: "analyze", taskId });
    return;

  } else if (cmd.kind === "suggest") {
    const prompt = (cmd.q || "").trim();
    if (!prompt) {
      await send(chatId, "Usage: /suggest <incident description>");
      return;
    }

    const taskId = `${taskIdPrefix}_suggest_${chatId}_${Date.now()}`;

    try {
      const res = await submitTask({
        task_id: taskId,
        stage: "suggest",
        prompt,
        context: {
          source: channel,
          chat_id: chatId,
          user_id: userId,
        },
      });

      if (!res?.ok) {
        await send(chatId, errorText(`Gateway error: ${res?.error || "unknown"}`));
        appendLedger(storageDir, { ...baseAudit, cmd: "suggest", taskId, ok: false, error: res?.error || "unknown" });
        return;
      }

      let out = `🛠️ Suggestion (facts-only)\n\n`;
      out += `Summary:\n${res.summary}\n`;

      if (res.files_touched?.length) {
        out += `\nFiles:\n`;
        for (const f of res.files_touched) out += `- ${f}\n`;
      }

      if (res.verify_cmds?.length) {
        out += `\nVerify:\n`;
        for (const c of res.verify_cmds) out += `- ${c}\n`;
      }

      if (res.warnings?.length) {
        out += `\nWarnings:\n`;
        for (const w of res.warnings) out += `- ${w}\n`;
      }

      await send(chatId, out);
    } catch (e: any) {
      await send(chatId, errorText(`suggest failed: ${String(e?.message || e)}`));
    }

    appendLedger(storageDir, { ...baseAudit, cmd: "suggest", taskId });
    return;
  }

  if (cmd.kind === "status") {
    const out = getStatusFacts(storageDir);
    await send(chatId, out);
    appendLedger(storageDir, { ...baseAudit, cmd: "status", out_tail: out.slice(-800) });
    return;
  }

  if (cmd.kind === "auth_list") {
    const out = `allowed:\n- ${authState.allowed.join("\n- ")}`;
    await send(chatId, out);
    appendLedger(storageDir, { ...baseAudit, cmd: "auth_list" });
    return;
  }

  if (cmd.kind === "auth_add") {
    if (!authState.allowed.includes(cmd.id)) authState.allowed.push(cmd.id);
    saveAuth(storageDir, authState, channel);
    await send(chatId, `added ${cmd.id}`);
    appendLedger(storageDir, { ...baseAudit, cmd: "auth_add", target: cmd.id });
    return;
  }

  if (cmd.kind === "auth_del") {
    authState.allowed = authState.allowed.filter(x => x !== cmd.id);
    saveAuth(storageDir, authState, channel);
    await send(chatId, `deleted ${cmd.id}`);
    appendLedger(storageDir, { ...baseAudit, cmd: "auth_del", target: cmd.id });
    return;
  }

  // unknown
  await send(chatId, "unknown command. /help");
  appendLedger(storageDir, { ...baseAudit, cmd: "unknown" });
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
      await send(chatId, "没有可反馈的解释。");
      return;
    }
    writeExplainFeedback(storageDir, {
      ts_utc: new Date().toISOString(),
      trace_id: last.trace_id,
      chat_id: chatId,
      user_id: userId,
      feedback: trimmedText === "👍" ? "up" : "down",
    });
    await send(chatId, "已记录反馈。");
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
        await send(chatId, "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。");
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
