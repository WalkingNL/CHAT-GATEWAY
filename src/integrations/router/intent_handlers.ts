import fs from "node:fs";
import path from "node:path";
import { appendLedger } from "../audit/ledger.js";
import { writeExplainTrace } from "../audit/trace_writer.js";
import { parseAlertText, LocalFsFactsProvider } from "../facts/index.js";
import { routeExplain } from "../explain/router_v1.js";
import { sanitizeRequestId } from "../runtime/intent_router.js";
import { INTENT_SCHEMA_VERSION, INTENT_VERSION } from "../runtime/intent_schema.js";
import { loadProjectRegistry } from "../runtime/project_registry.js";
import { postJsonWithAuth } from "../runtime/http_client.js";
import { errorText, rejectText } from "../runtime/response_templates.js";
import { submitTask } from "../../core/internal_client.js";
import type { LoadedConfig } from "../../core/config/types.js";
import { clip, clipToLen, nowIso, parseIntEnv } from "./router_utils.js";
import { setLastExplainTrace } from "./state_cache.js";

export const NEWS_SUMMARY_DEFAULT_CHARS = 200;
export const NEWS_SUMMARY_MAX_CHARS = 1200;
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

export type NewsItem = {
  title: string;
  published?: string;
  source?: string;
  link?: string;
};

export function buildDispatchRequestId(requestIdBase: string, attempt: number): string {
  return sanitizeRequestId(`${requestIdBase}:${attempt}`);
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

export function isNewsAlert(raw: string): boolean {
  const s = String(raw || "");
  if (!s.trim()) return false;
  if (NEWS_ALERT_MARKERS.some(m => s.includes(m))) return true;
  const hasBullet = s.includes("• ");
  const hasLink = s.includes("链接:");
  if (hasBullet && hasLink && s.includes("新闻")) return true;
  const parsed = parseNewsAlert(s);
  return parsed.items.length > 0;
}

function parseSummaryLength(text: string): number | null {
  const t = String(text || "");
  let m = t.match(/(\d{2,4})\s*(字|字符)/);
  if (m) return Number(m[1]);
  m = t.match(/(\d{2,4})/);
  if (m) return Number(m[1]);
  return null;
}

export function resolveSummaryLength(text: string): number {
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

export function parseNewsAlert(rawAlert: string): { items: NewsItem[]; facts: string } {
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

export function resolveProjectId(config?: LoadedConfig): string | null {
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
      || "CRYPTO_AGENT_ON_DEMAND_TOKEN",
  );
  const token = String(process.env[tokenEnv] || onDemand.token || envToken || "").trim();

  return { url, token, projectId };
}

async function fetchNewsSummary(params: {
  rawAlert: string;
  maxChars: number;
  config?: LoadedConfig;
}): Promise<{ ok: boolean; summary: string; error?: string; items: number | null }> {
  const { rawAlert, maxChars, config } = params;
  const parsed = parseNewsAlert(rawAlert);
  const facts = parsed.facts || rawAlert;
  const prompt = buildNewsSummaryPrompt(facts, maxChars);
  const cfg = resolveOnDemandConfigForNews(config);
  const res = await postJsonWithAuth(cfg.url, cfg.token, {
    kind: "news_summary",
    prompt,
    max_chars: maxChars,
    project_id: cfg.projectId,
  });
  if (!res.ok) {
    return { ok: false, summary: "", error: res.error || "unknown", items: parsed.items.length || null };
  }
  const summary = String(res.summary || res.result || "");
  return { ok: true, summary, items: parsed.items.length || null };
}

export type ExplainContext = {
  project_id: string | null;
  alert_raw: string;
  parsed: ReturnType<typeof parseAlertText> | null;
  facts: ReturnType<LocalFsFactsProvider["buildExplainFacts"]> | { degraded: true; reason: string };
  signals: SignalsContext;
};

async function collectFacts(params: {
  config?: LoadedConfig;
  project_id: string | null;
  symbol?: string | null;
  anchor_ms?: number | null;
}): Promise<ExplainContext["facts"]> {
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

async function buildExplainContext(rawAlert: string, config?: LoadedConfig): Promise<ExplainContext> {
  const parsedRaw = parseAlertText(rawAlert);
  const parsed = parsedRaw.ok ? parsedRaw : null;
  const projectId = resolveProjectId(config);
  const facts: ExplainContext["facts"] = parsed
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

export async function getSignalsDigest(config: LoadedConfig | undefined, minutes: number) {
  const res = await readSignalsRows(config, minutes);
  if (!res.ok) return res;
  return {
    ok: true as const,
    summary: buildSignalsSummary(res.rows, res.startMs, res.endMs),
  };
}

export function formatSignalsDigest(minutes: number, summary: ReturnType<typeof buildSignalsSummary>) {
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

export async function runExplain(params: {
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

export async function runNewsSummary(params: {
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
    const clipped = clipToLen(cached.summary, maxChars);
    await send(chatId, clipped);
    appendLedger(storageDir, {
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
      ok: true,
      latency_ms: Date.now() - t0,
      summary_head: clipToLen(clipped, Math.min(240, maxChars)),
      summary_chars: clipped.length,
      source: cached.source,
      items: cached.items ?? undefined,
      adapter_entry: adapterEntry || undefined,
    });
    return;
  }

  const result = await fetchNewsSummary({ rawAlert, maxChars, config });
  if (!result.ok) {
    await send(chatId, errorText(`摘要异常：${result.error || "unknown"}`));
    appendLedger(storageDir, {
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
      ok: false,
      err: result.error || "unknown",
      latency_ms: Date.now() - t0,
      summary_head: "",
      summary_chars: 0,
      items: result.items ?? undefined,
      adapter_entry: adapterEntry || undefined,
    });
    return;
  }

  const summaryRaw = result.summary || "";
  const summary = clipToLen(summaryRaw, maxChars);
  await send(chatId, summary);
  newsSummaryCache.set(requestId, {
    summary,
    source: "on_demand",
    items: result.items ?? null,
    ts: Date.now(),
  });

  appendLedger(storageDir, {
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
    ok: true,
    latency_ms: Date.now() - t0,
    summary_head: clipToLen(summary, Math.min(240, maxChars)),
    summary_chars: summary.length,
    source: "on_demand",
    items: result.items ?? undefined,
    adapter_entry: adapterEntry || undefined,
  });
}

export async function runNewsQuery(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  channel: string;
  send: (chatId: string, text: string) => Promise<void>;
  config?: LoadedConfig;
  kind: "news_hot" | "news_refresh";
  limit?: number;
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
  const requestLimit = clampLimit(limit, NEWS_QUERY_DEFAULT_LIMIT, NEWS_QUERY_MAX_LIMIT);
  const requestIdBase = params.requestIdBase || sanitizeRequestId([channel, chatId, kind].join(":"));
  const attempt = params.attempt && params.attempt > 0 ? params.attempt : 1;
  const requestId = params.requestId || buildDispatchRequestId(requestIdBase, attempt);

  const cfg = resolveOnDemandConfigForNews(config);
  const res = await postJsonWithAuth(cfg.url, cfg.token, {
    kind,
    limit: requestLimit,
    project_id: cfg.projectId,
  });
  if (!res.ok) {
    await send(chatId, errorText(`新闻查询失败：${res.error || "unknown"}`));
    appendLedger(storageDir, {
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
      ok: false,
      err: res.error || "unknown",
      latency_ms: Date.now() - t0,
      limit: requestLimit,
      adapter_entry: adapterEntry || undefined,
    });
    return;
  }

  const text = String(res.text || res.result || "").trim();
  await send(chatId, text || "(无)" );
  appendLedger(storageDir, {
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
    ok: true,
    latency_ms: Date.now() - t0,
    limit: requestLimit,
    adapter_entry: adapterEntry || undefined,
  });
}

export async function runDataFeedsStatus(params: {
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
  const requestIdBase = params.requestIdBase || sanitizeRequestId([channel, chatId, "data_feeds_status"].join(":"));
  const attempt = params.attempt && params.attempt > 0 ? params.attempt : 1;
  const requestId = params.requestId || buildDispatchRequestId(requestIdBase, attempt);

  const cfg = resolveOnDemandConfigForNews(config);
  const res = await postJsonWithAuth(cfg.url, cfg.token, {
    kind: "data_feeds_status",
    project_id: cfg.projectId,
  });
  if (!res.ok) {
    await send(chatId, errorText(`数据源状态异常：${res.error || "unknown"}`));
    appendLedger(storageDir, {
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
      ok: false,
      err: res.error || "unknown",
      latency_ms: Date.now() - t0,
      adapter_entry: adapterEntry || undefined,
    });
    return;
  }

  const summary = clip(String(res.summary || res.text || res.result || ""), 800);
  await send(chatId, summary || "(无)" );
  appendLedger(storageDir, {
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
    ok: true,
    latency_ms: Date.now() - t0,
    adapter_entry: adapterEntry || undefined,
  });
}

export async function runDataFeedsAssetStatus(params: {
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
  const requestIdBase = params.requestIdBase || sanitizeRequestId([channel, chatId, symbol, "data_feeds_asset_status"].join(":"));
  const attempt = params.attempt && params.attempt > 0 ? params.attempt : 1;
  const requestId = params.requestId || buildDispatchRequestId(requestIdBase, attempt);

  const cfg = resolveOnDemandConfigForNews(config);
  const res = await postJsonWithAuth(cfg.url, cfg.token, {
    kind: "data_feeds_asset_status",
    symbol,
    project_id: cfg.projectId,
  });
  if (!res.ok) {
    await send(chatId, errorText(`数据源资产异常：${res.error || "unknown"}`));
    appendLedger(storageDir, {
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
      ok: false,
      err: res.error || "unknown",
      latency_ms: Date.now() - t0,
      adapter_entry: adapterEntry || undefined,
    });
    return;
  }

  const summary = clip(String(res.summary || res.text || res.result || ""), 800);
  const lines: string[] = [`数据源资产状态：${symbol || "未知"}`];
  if (summary) lines.push(summary);
  const out = lines.join("\n");
  await send(chatId, out);
  appendLedger(storageDir, {
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
    ok: true,
    latency_ms: Date.now() - t0,
    adapter_entry: adapterEntry || undefined,
  });
}

export async function runDataFeedsSourceStatus(params: {
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
  const requestIdBase = params.requestIdBase || sanitizeRequestId([channel, chatId, feedId, "data_feeds_source_status"].join(":"));
  const attempt = params.attempt && params.attempt > 0 ? params.attempt : 1;
  const requestId = params.requestId || buildDispatchRequestId(requestIdBase, attempt);

  const cfg = resolveOnDemandConfigForNews(config);
  const res = await postJsonWithAuth(cfg.url, cfg.token, {
    kind: "data_feeds_source_status",
    feed_id: feedId,
    project_id: cfg.projectId,
  });
  if (!res.ok) {
    await send(chatId, errorText(`数据源 feed 异常：${res.error || "unknown"}`));
    appendLedger(storageDir, {
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
      ok: false,
      err: res.error || "unknown",
      latency_ms: Date.now() - t0,
      adapter_entry: adapterEntry || undefined,
    });
    return;
  }

  const summary = clip(String(res.summary || res.text || res.result || ""), 800);
  const lines: string[] = [`数据源状态：${feedId || "未知"}`];
  if (summary) lines.push(summary);
  const out = lines.join("\n");
  await send(chatId, out);
  appendLedger(storageDir, {
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
    ok: true,
    latency_ms: Date.now() - t0,
    adapter_entry: adapterEntry || undefined,
  });
}

export async function runDataFeedsHotspots(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  channel: string;
  send: (chatId: string, text: string) => Promise<void>;
  config?: LoadedConfig;
  limit?: number;
  adapterEntry?: boolean;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
}) {
  const { storageDir, chatId, userId, channel, send, config, limit, adapterEntry } = params;
  const t0 = Date.now();
  const requestLimit = clampLimit(limit, FEEDS_QUERY_DEFAULT_LIMIT, FEEDS_QUERY_MAX_LIMIT);
  const requestIdBase = params.requestIdBase || sanitizeRequestId([channel, chatId, "data_feeds_hotspots"].join(":"));
  const attempt = params.attempt && params.attempt > 0 ? params.attempt : 1;
  const requestId = params.requestId || buildDispatchRequestId(requestIdBase, attempt);

  const cfg = resolveOnDemandConfigForNews(config);
  const res = await postJsonWithAuth(cfg.url, cfg.token, {
    kind: "data_feeds_hotspots",
    limit: requestLimit,
    project_id: cfg.projectId,
  });
  if (!res.ok) {
    await send(chatId, errorText(`数据源热点异常：${res.error || "unknown"}`));
    appendLedger(storageDir, {
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
      ok: false,
      err: res.error || "unknown",
      latency_ms: Date.now() - t0,
      limit: requestLimit,
      adapter_entry: adapterEntry || undefined,
    });
    return;
  }

  const out = clipToLen(String(res.summary || res.text || res.result || ""), 3500);
  await send(chatId, out || "(无)" );
  appendLedger(storageDir, {
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
    ok: true,
    latency_ms: Date.now() - t0,
    limit: requestLimit,
    adapter_entry: adapterEntry || undefined,
  });
}

export async function runDataFeedsOpsSummary(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  channel: string;
  send: (chatId: string, text: string) => Promise<void>;
  config?: LoadedConfig;
  limit?: number;
  adapterEntry?: boolean;
  requestId?: string;
  requestIdBase?: string;
  attempt?: number;
}) {
  const { storageDir, chatId, userId, channel, send, config, limit, adapterEntry } = params;
  const t0 = Date.now();
  const requestLimit = clampLimit(limit, FEEDS_QUERY_DEFAULT_LIMIT, FEEDS_QUERY_MAX_LIMIT);
  const requestIdBase = params.requestIdBase || sanitizeRequestId([channel, chatId, "data_feeds_ops_summary"].join(":"));
  const attempt = params.attempt && params.attempt > 0 ? params.attempt : 1;
  const requestId = params.requestId || buildDispatchRequestId(requestIdBase, attempt);

  const cfg = resolveOnDemandConfigForNews(config);
  const res = await postJsonWithAuth(cfg.url, cfg.token, {
    kind: "data_feeds_ops_summary",
    limit: requestLimit,
    project_id: cfg.projectId,
  });
  if (!res.ok) {
    await send(chatId, errorText(`数据源摘要异常：${res.error || "unknown"}`));
    appendLedger(storageDir, {
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
      ok: false,
      err: res.error || "unknown",
      latency_ms: Date.now() - t0,
      limit: requestLimit,
      adapter_entry: adapterEntry || undefined,
    });
    return;
  }

  const out = clipToLen(String(res.summary || res.text || res.result || ""), 3500);
  await send(chatId, out || "(无)" );
  appendLedger(storageDir, {
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
    ok: true,
    latency_ms: Date.now() - t0,
    limit: requestLimit,
    adapter_entry: adapterEntry || undefined,
  });
}
