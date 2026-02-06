import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { handleAskCommand } from "./commands.js";
import { appendLedger } from "../audit/ledger.js";
import { getStatusFacts } from "./context.js";
import { loadAuth, saveAuth } from "../auth/store.js";
import { submitTask } from "../../core/internal_client.js";
import { evaluate } from "../../core/config/index.js";
import type { LoadedConfig } from "../../core/config/types.js";
import { errorText, rejectText } from "../runtime/response_templates.js";
import { COMMAND_MESSAGES, INTERACTION_MESSAGES, ensureIntentEnabledForCommand } from "./intent_policy.js";
import { ACCESS_MESSAGES } from "./intent_policy.js";
import { nowIso } from "./router_utils.js";
import type { SendFn } from "./router_types.js";
import {
  formatSignalsDigest,
  getSignalsDigest,
  resolveProjectId,
  runDataFeedsAssetStatus,
  runDataFeedsHotspots,
  runDataFeedsOpsSummary,
  runDataFeedsSourceStatus,
  runDataFeedsStatus,
  runNewsQuery,
} from "./intent_handlers.js";
import { setLastAlert } from "./state_cache.js";

export type ParsedCommand = ReturnType<typeof import("./commands.js").parseCommand>;

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

export async function handleOpsCommand(params: {
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
      await send(chatId, res.deny_message || rejectText(ACCESS_MESSAGES.ownerOnlyExplain));
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
      await send(chatId, res.deny_message || rejectText(ACCESS_MESSAGES.ownerOnlyExplain));
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
      await send(chatId, res.deny_message || rejectText(ACCESS_MESSAGES.ownerOnlyExplain));
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

export async function handlePrivateMessage(params: {
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
    await send(chatId, INTERACTION_MESSAGES.quickHelp);
    return true;
  }

  if (!isCommand) {
    return false;
  }

  return false;
}

export async function handleParsedCommand(params: {
  cmd: ParsedCommand;
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
    await send(chatId, rejectText(COMMAND_MESSAGES.authDenied));
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
    if (!await ensureIntentEnabledForCommand(send, chatId, "news_hot", "未开放新闻查询能力。")) return;
    await runNewsQuery({
      storageDir,
      chatId,
      userId,
      channel,
      send,
      config,
      kind: "news_hot",
      limit: cmd.limit ?? undefined,
    });
    return;

  } else if (cmd.kind === "news_refresh") {
    if (!await ensureIntentEnabledForCommand(send, chatId, "news_refresh", "未开放新闻查询能力。")) return;
    await runNewsQuery({
      storageDir,
      chatId,
      userId,
      channel,
      send,
      config,
      kind: "news_refresh",
      limit: cmd.limit ?? undefined,
    });
    return;

  } else if (cmd.kind === "feeds_status") {
    if (!await ensureIntentEnabledForCommand(
      send,
      chatId,
      "data_feeds_status",
      "未开放数据源查询能力。",
    )) return;
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
    if (!await ensureIntentEnabledForCommand(
      send,
      chatId,
      "data_feeds_asset_status",
      "未开放数据源查询能力。",
    )) return;
    const symbol = String(cmd.symbol || "").trim();
    if (!symbol) {
      await send(chatId, COMMAND_MESSAGES.feedsAssetUsage);
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
    if (!await ensureIntentEnabledForCommand(
      send,
      chatId,
      "data_feeds_source_status",
      "未开放数据源查询能力。",
    )) return;
    const feedId = String(cmd.feedId || "").trim();
    if (!feedId) {
      await send(chatId, COMMAND_MESSAGES.feedsSourceUsage);
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
    if (!await ensureIntentEnabledForCommand(
      send,
      chatId,
      "data_feeds_hotspots",
      "未开放数据源查询能力。",
    )) return;
    await runDataFeedsHotspots({
      storageDir,
      chatId,
      userId,
      channel,
      send,
      config,
      limit: cmd.limit ?? undefined,
    });
    return;

  } else if (cmd.kind === "feeds_ops") {
    if (!await ensureIntentEnabledForCommand(
      send,
      chatId,
      "data_feeds_ops_summary",
      "未开放数据源查询能力。",
    )) return;
    await runDataFeedsOpsSummary({
      storageDir,
      chatId,
      userId,
      channel,
      send,
      config,
      limit: cmd.limit ?? undefined,
    });
    return;

  } else if (cmd.kind === "signals") {
    const maxWindow = getMaxWindowMinutes();
    if (!cmd.minutes) {
      await send(chatId, COMMAND_MESSAGES.signalsUsage(maxWindow));
      return;
    }
    if (cmd.minutes > maxWindow) {
      await send(chatId, COMMAND_MESSAGES.signalsTooLarge(maxWindow));
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
      await send(chatId, COMMAND_MESSAGES.analyzeUsage);
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
      await send(chatId, COMMAND_MESSAGES.suggestUsage);
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
    authState.allowed = authState.allowed.filter((x) => x !== cmd.id);
    saveAuth(storageDir, authState, channel);
    await send(chatId, `deleted ${cmd.id}`);
    appendLedger(storageDir, { ...baseAudit, cmd: "auth_del", target: cmd.id });
    return;
  }

  await send(chatId, INTERACTION_MESSAGES.unknownCommand);
  appendLedger(storageDir, { ...baseAudit, cmd: "unknown" });
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
  return names.map((n: unknown) => String(n)).filter((n: string) => Boolean(n));
}
