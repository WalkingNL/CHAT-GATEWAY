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

const lastAlertByChatId = new Map<string, { ts: number; rawText: string }>();

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

  const trimmedText = (text || "").trim();
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

  // -------------------------------
  // C1: ops commands (facts-only)
  // /status, /ps, /logs <pm2_name> [lines]
  // -------------------------------
  const MAX_LINES_DEFAULT = Number(process.env.GW_MAX_LOG_LINES || 200);
  const TELEGRAM_SAFE_MAX = 3500;
  const MAX_LOG_CHARS = Math.min(
    Number(process.env.GW_MAX_LOG_CHARS || TELEGRAM_SAFE_MAX),
    TELEGRAM_SAFE_MAX,
  );
  const clampLines = (n: number) => {
    if (!Number.isFinite(n) || n <= 0) return 80;
    return Math.min(Math.max(1, Math.floor(n)), MAX_LINES_DEFAULT);
  };

  const pm2Jlist = (): any[] => {
    try {
      const out = execSync("pm2 jlist", { encoding: "utf-8" });
      return JSON.parse(out);
    } catch {
      return [];
    }
  };

  const fmtUptime = (ms: number) => {
    if (!ms || ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d${h % 24}h`;
    if (h > 0) return `${h}h${m % 60}m`;
    return `${m}m`;
  };

  const renderPs = (allowedNames: string[]) => {
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
  };

  const renderStatus = (allowedNames: string[]) => {
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
  };

  const resolvePm2LogPath = (name: string, stream: "out" | "error") => {
    const base = path.join(os.homedir(), ".pm2", "logs");
    return path.join(base, `${name}-${stream}.log`);
  };

  const tailFile = (filePath: string, n: number): string => {
    const cmd = `tail -n ${n} ${filePath.replace(/(["\\$`])/g, "\\$1")}`;
    return execSync(cmd, { encoding: "utf-8" });
  };

  const renderLogs = (name: string, lines: number) => {
    const n = clampLines(lines);
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
  };

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
    if (res.require?.mention_bot_for_ops && !mentionsBot) return;
    const isAllowed = policyOk ? res.allowed : allowed;
    if (!isAllowed) {
      await send(chatId, res.deny_message || "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。");
      return;
    }
    await send(chatId, renderStatus(pm2PsNames));
    return;
  }

  if (cleanedText.startsWith("/ps")) {
    const res = evalOps("ops.ps");
    if (res.require?.mention_bot_for_ops && !mentionsBot) return;
    const isAllowed = policyOk ? res.allowed : allowed;
    if (!isAllowed) {
      await send(chatId, res.deny_message || "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。");
      return;
    }
    await send(chatId, renderPs(pm2PsNames));
    return;
  }

  if (cleanedText.startsWith("/logs")) {
    const res = evalOps("ops.logs");
    if (res.require?.mention_bot_for_ops && !mentionsBot) return;
    const isAllowed = policyOk ? res.allowed : allowed;
    if (!isAllowed) {
      await send(chatId, res.deny_message || "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。");
      return;
    }
    const parts = cleanedText.split(/\s+/).filter(Boolean);
    if (!pm2LogsNames.length) {
      await send(chatId, "⚠️ 未配置 pm2 日志进程名（manifest: pm2_logs.names）。");
      return;
    }
    const name = parts[1] || pm2LogsNames[0];
    if (!pm2LogsNames.includes(name)) {
      await send(chatId, `⚠️ 不允许的进程名：${name}`);
      return;
    }
    const lines = parts[2] ? Number(parts[2]) : 80;
    const out = renderLogs(name, lines);
    if (out.length > MAX_LOG_CHARS) {
      const head = out.slice(0, Math.max(0, MAX_LOG_CHARS - 40));
      const msg =
        `⚠️ 输出过长，已截断到 ${MAX_LOG_CHARS} 字符（上限 ${TELEGRAM_SAFE_MAX}）。\n` +
        head +
        "\n...(clipped)";
      await send(chatId, msg);
      return;
    }
    await send(chatId, out);
    return;
  }

  if (isGroup) {
    // ---- Group command path: allow commands without @bot (still owner/allowlist gated) ----
    if (isCommand) {
      if (!allowed) {
        await send(chatId, "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。");
        return;
      }
      // fall through to command parsing/dispatch below
    } else {
      // ---- Group explain path: policy-driven gate ----
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

      const ctx = await buildExplainContext(trimmedReplyText, config);

      const taskId = `tg_explain_${chatId}_${Date.now()}`;

      await send(chatId, "🧠 我看一下…");

      const prompt =
        "解释这条告警（facts-only）：\n" +
        "1) 发生了什么（用人话）\n" +
        "2) 关键结构特征（如量价背离/稳定币）\n" +
        "3) 可能原因（推断要写依据+置信度）\n" +
        "4) 下一步建议看什么（facts-only，不给交易建议）\n" +
        "禁止：价格预测、买卖建议、无依据故事。\n" +
        "If facts.window_1h/24h/symbol_recent.ok is true, you MUST reference them. " +
        "If false, explicitly say what is missing.\n";

      try {
        const res = await submitTask({
          task_id: taskId,
          stage: "analyze",
          prompt,
          context: ctx,
        });

        if (!res?.ok) {
          await send(chatId, `解释失败：${res?.error || "unknown"}`);
          return;
        }

        await send(chatId, res.summary);
      } catch (e: any) {
        await send(chatId, `解释异常：${String(e?.message || e)}`);
      }

      return;
    }
  }

  if (!allowed && !isGroup) return;

  if (!isGroup) {
    if (trimmedReplyText) {
      lastAlertByChatId.set(chatId, { ts: Date.now(), rawText: trimmedReplyText });
    }

    if (trimmedText === "/help" || trimmedText === "help") {
      await send(chatId, "用法：回复一条告警，然后发“解释一下/？”即可。");
      return;
    }

    if (!isCommand) {
      const rawAlert = trimmedReplyText || lastAlertByChatId.get(chatId)?.rawText || "";
      if (!rawAlert) {
        await send(chatId, "请先回复一条告警消息，然后发一句话（如：解释一下）。");
        return;
      }

      const ctx = await buildExplainContext(rawAlert, config);

      const taskId = `tg_explain_${chatId}_${Date.now()}`;

      await send(chatId, "🧠 我看一下…");

      const prompt =
        "解释这条告警（facts-only）：\n" +
        "1) 发生了什么（用人话）\n" +
        "2) 关键结构特征（如量价背离/稳定币）\n" +
        "3) 可能原因（推断要写依据+置信度）\n" +
        "4) 下一步建议看什么（facts-only，不给交易建议）\n" +
        "禁止：价格预测、买卖建议、无依据故事。\n" +
        "If facts.window_1h/24h/symbol_recent.ok is true, you MUST reference them. " +
        "If false, explicitly say what is missing.\n";

      try {
        const res = await submitTask({
          task_id: taskId,
          stage: "analyze",
          prompt,
          context: ctx,
        });

        if (!res?.ok) {
          await send(chatId, `解释失败：${res?.error || "unknown"}`);
          return;
        }

        await send(chatId, res.summary);
      } catch (e: any) {
        await send(chatId, `解释异常：${String(e?.message || e)}`);
      }

      return;
    }
  }

  const cmd = parseCommand(cleanedText);

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
