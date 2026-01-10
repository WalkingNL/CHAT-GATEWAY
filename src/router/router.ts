import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { handleAskCommand, parseCommand } from "./commands.js";
import { appendLedger } from "../audit/ledger.js";
import { getStatusFacts } from "./context.js";
import { RateLimiter } from "../rateLimit/limiter.js";
import { loadAuth, saveAuth } from "../auth/store.js";
import type { LLMProvider, ChatMessage } from "../providers/base.js";
import { submitTask } from "../internal_client.js";
import { evaluate } from "../config/index.js";
import type { LoadedConfig } from "../config/types.js";
import { parseAlertText, LocalFsFactsProvider } from "../facts/index.js";
import { routeExplain } from "../explain/router_v1.js";
import { writeExplainTrace, writeExplainFeedback } from "../audit/trace_writer.js";

const lastAlertByChatId = new Map<string, { ts: number; rawText: string }>();
const lastExplainByChatId = new Map<string, { ts: number; trace_id: string }>();
const FEEDBACK_TOO_MANY = ["告警太多", "太多了", "一直在刷", "刷屏", "太吵", "好多告警"];
const FEEDBACK_TOO_FEW = ["告警太少", "太安静", "没动静", "怎么没告警", "是不是坏了", "系统坏了"];

function nowIso() {
  return new Date().toISOString();
}

function clip(s: string, n: number) {
  const t = String(s || "");
  return t.length <= n ? t : t.slice(0, n) + "…";
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  return {
    project_id: projectId,
    alert_raw: rawAlert,
    parsed,
    facts,
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

async function runExplain(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  rawAlert: string;
  send: (chatId: string, text: string) => Promise<void>;
  config?: LoadedConfig;
  channel: string;
  taskIdPrefix: string;
}) {
  const { storageDir, chatId, userId, rawAlert, send, config, channel, taskIdPrefix } = params;
  const t0 = Date.now();
  const ctx = await buildExplainContext(rawAlert, config);
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
      await send(chatId, `解释失败：${errCode}`);
    } else {
      ok = true;
      summary = String(res.summary || "");
      await send(chatId, summary);
    }
  } catch (e: any) {
    latencyMs = Date.now() - t0;
    errCode = String(e?.message || e);
    await send(chatId, `解释异常：${errCode}`);
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
  lastExplainByChatId.set(chatId, { ts: Date.now(), trace_id: taskId });
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
    channel: "telegram",
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
      await send(chatId, res.deny_message || "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。");
      return true;
    }
    await send(chatId, renderStatus(pm2PsNames));
    return true;
  }

  if (cleanedText.startsWith("/ps")) {
    const res = evalOps("ops.ps");
    if (res.require?.mention_bot_for_ops && !mentionsBot) return true;
    const isAllowed = policyOk ? res.allowed : allowed;
    if (!isAllowed) {
      await send(chatId, res.deny_message || "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。");
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
      await send(chatId, res.deny_message || "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。");
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

async function handleGroupExplain(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  trimmedReplyText: string;
  mentionsBot: boolean;
  send: SendFn;
  config?: LoadedConfig;
}) {
  const { storageDir, chatId, userId, trimmedReplyText, mentionsBot, send, config } = params;
  const res = evaluate(config, {
    channel: "telegram",
    capability: "alerts.explain",
    chat_id: chatId,
    chat_type: "group",
    user_id: userId,
    mention_bot: mentionsBot,
    has_reply: Boolean(trimmedReplyText),
  });

  if (res.require?.mention_bot_for_explain && !mentionsBot) return;

  if (res.require?.reply_required_for_explain && !trimmedReplyText) {
    await send(chatId, "请回复一条告警消息再 @我，我才能解释。");
    return;
  }

  if (!res.allowed) {
    await send(chatId, res.deny_message || "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。");
    return;
  }

  await send(chatId, "🧠 我看一下…");
  await runExplain({
    storageDir,
    chatId,
    userId,
    rawAlert: trimmedReplyText,
    send,
    config,
    channel: "telegram",
    taskIdPrefix: "tg_explain",
  });
}

async function handlePrivateMessage(params: {
  storageDir: string;
  chatId: string;
  userId: string;
  trimmedText: string;
  trimmedReplyText: string;
  isCommand: boolean;
  send: SendFn;
  config?: LoadedConfig;
}): Promise<boolean> {
  const {
    storageDir,
    chatId,
    userId,
    trimmedText,
    trimmedReplyText,
    isCommand,
    send,
    config,
  } = params;

  if (trimmedReplyText) {
    lastAlertByChatId.set(chatId, { ts: Date.now(), rawText: trimmedReplyText });
  }

  if (trimmedText === "/help" || trimmedText === "help") {
    await send(chatId, "用法：回复一条告警，然后发“解释一下/？”即可。");
    return true;
  }

  if (!isCommand) {
    const rawAlert = trimmedReplyText || lastAlertByChatId.get(chatId)?.rawText || "";
    if (!rawAlert) {
      await send(chatId, "请先回复一条告警消息，然后发一句话（如：解释一下）。");
      return true;
    }

    await send(chatId, "🧠 我看一下…");
    await runExplain({
      storageDir,
      chatId,
      userId,
      rawAlert,
      send,
      config,
      channel: "telegram",
      taskIdPrefix: "tg_explain",
    });
    return true;
  }

  return false;
}

async function handleParsedCommand(params: {
  cmd: ReturnType<typeof parseCommand>;
  storageDir: string;
  chatId: string;
  userId: string;
  text: string;
  isOwner: boolean;
  authState: ReturnType<typeof loadAuth>;
  send: SendFn;
}) {
  const { cmd, storageDir, chatId, userId, text, isOwner, authState, send } = params;

  // auth commands only owner
  if (cmd.kind.startsWith("auth_") && !isOwner) {
    await send(chatId, "permission denied");
    return;
  }

  const ts = nowIso();
  const baseAudit = { ts_utc: ts, channel: "telegram", chat_id: chatId, user_id: userId, raw: text };

  if (cmd.kind === "help") {
    const out = [
      "/help",
      "/status",
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

  } else if (cmd.kind === "ask") {
    await handleAskCommand({
      chatId,
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

    const taskId = `tg_analyze_${chatId}_${Date.now()}`;

    try {
      const res = await submitTask({
        task_id: taskId,
        stage: "analyze",
        prompt,
        context: {
          source: "telegram",
          chat_id: chatId,
          user_id: userId,
        },
      });

      if (!res?.ok) {
        await send(chatId, `❌ Gateway error: ${res?.error || "unknown"}`);
        appendLedger(storageDir, { ...baseAudit, cmd: "analyze", taskId, ok: false, error: res?.error || "unknown" });
        return;
      }

      await send(chatId, `🧠 Analysis (facts-only)\n\n${res.summary}`);
    } catch (e: any) {
      await send(chatId, `❌ analyze failed: ${String(e?.message || e)}`);
    }

    appendLedger(storageDir, { ...baseAudit, cmd: "analyze", taskId });
    return;

  } else if (cmd.kind === "suggest") {
    const prompt = (cmd.q || "").trim();
    if (!prompt) {
      await send(chatId, "Usage: /suggest <incident description>");
      return;
    }

    const taskId = `tg_suggest_${chatId}_${Date.now()}`;

    try {
      const res = await submitTask({
        task_id: taskId,
        stage: "suggest",
        prompt,
        context: {
          source: "telegram",
          chat_id: chatId,
          user_id: userId,
        },
      });

      if (!res?.ok) {
        await send(chatId, `❌ Gateway error: ${res?.error || "unknown"}`);
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
      await send(chatId, `❌ suggest failed: ${String(e?.message || e)}`);
    }

    appendLedger(storageDir, { ...baseAudit, cmd: "suggest", taskId });
    return;
  }

  if (cmd.kind === "status") {
    const out = getStatusFacts();
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
    saveAuth(storageDir, authState);
    await send(chatId, `added ${cmd.id}`);
    appendLedger(storageDir, { ...baseAudit, cmd: "auth_add", target: cmd.id });
    return;
  }

  if (cmd.kind === "auth_del") {
    authState.allowed = authState.allowed.filter(x => x !== cmd.id);
    saveAuth(storageDir, authState);
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
  ownerChatId: string;
  // NOTE: ownerChatId is private chat_id; group owner gating must use OWNER_TELEGRAM_USER_ID
  allowlistMode: "owner_only" | "auth";
  config?: LoadedConfig;
  provider: LLMProvider;
  limiter: RateLimiter;
  chatId: string;
  userId: string;
  text: string;
  replyText?: string;
  isGroup?: boolean;
  mentionsBot?: boolean;
  send: (chatId: string, text: string) => Promise<void>;
}) {
  const {
    storageDir,
    ownerChatId,
    allowlistMode,
    config,
    chatId,
    userId,
    text,
    replyText = "",
    isGroup = false,
    mentionsBot = false,
    send,
    provider,
    limiter,
  } = opts;

  let textNorm = (text || "").trim();
  // feedback command channel (works under Telegram privacy mode in groups)
  if (textNorm.startsWith("/feedback")) {
    textNorm = textNorm.replace(/^\/feedback\s*/i, "").trim();
  }
  const hitTooMany = FEEDBACK_TOO_MANY.some((k) => textNorm.includes(k));
  const hitTooFew = FEEDBACK_TOO_FEW.some((k) => textNorm.includes(k));

  if (hitTooMany || hitTooFew) {
    await send(
      chatId,
      "已收到反馈。\n我会关注近期告警密度，并在不影响异常捕获的前提下做调整。"
    );

    appendLedger(storageDir, {
      ts_utc: nowIso(),
      channel: "telegram",
      chat_id: chatId,
      user_id: userId,
      kind: "alert_feedback",
      feedback: hitTooMany ? "too_many" : "too_few",
      raw: textNorm,
    });

    return;
  }

  const trimmedText = textNorm;
  const authState = loadAuth(storageDir, ownerChatId);
  const ownerUserId = String(process.env.OWNER_TELEGRAM_USER_ID || "");
  const isOwnerChat = chatId === ownerChatId;
  const isOwnerUser = ownerUserId ? userId === ownerUserId : false;
  const isOwner = isOwnerChat || isOwnerUser;
  const allowed =
    allowlistMode === "owner_only"
      ? (isGroup ? isOwnerUser : isOwnerChat)
      : authState.allowed.includes(chatId) || isOwnerUser;

  const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || "SoliaNLBot");
  const mentionToken = botUsername
    ? (botUsername.startsWith("@") ? botUsername : `@${botUsername}`)
    : "";
  const mentionPattern = mentionToken ? new RegExp(escapeRegExp(mentionToken), "gi") : null;
  // Strip @bot mention for command parsing in groups (e.g. "@SoliaNLBot /status")
  const cleanedText =
    isGroup && mentionsBot && mentionPattern
      ? trimmedText.replace(mentionPattern, "").trim()
      : trimmedText;
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
    const last = lastExplainByChatId.get(chatId);
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
      await handleGroupExplain({
        storageDir,
        chatId,
        userId,
        trimmedReplyText,
        mentionsBot,
        send,
        config,
      });
      return;
    }
  }

  if (!allowed && !isGroup) return;

  if (!isGroup) {
    const handledPrivate = await handlePrivateMessage({
      storageDir,
      chatId,
      userId,
      trimmedText,
      trimmedReplyText,
      isCommand,
      send,
      config,
    });
    if (handledPrivate) return;
  }

  const cmd = parseCommand(cleanedText);
  await handleParsedCommand({
    cmd,
    storageDir,
    chatId,
    userId,
    text,
    isOwner,
    authState,
    send,
  });
}
