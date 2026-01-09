import { handleAskCommand, parseCommand } from "./commands.js";
import { appendLedger } from "../audit/ledger.js";
import { getStatusFacts } from "./context.js";
import { RateLimiter } from "../rateLimit/limiter.js";
import { loadAuth, saveAuth } from "../auth/store.js";
import type { LLMProvider, ChatMessage } from "../providers/base.js";
import { submitTask } from "../internal_client.js";

const lastAlertByChatId = new Map<string, { ts: number; rawText: string }>();

function nowIso() {
  return new Date().toISOString();
}

function clip(s: string, n: number) {
  const t = String(s || "");
  return t.length <= n ? t : t.slice(0, n) + "…";
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

  // Strip @bot mention for command parsing in groups (e.g. "@SoliaNLBot /status")
  const cleanedText =
    isGroup && mentionsBot
      ? trimmedText.replace(/@\w+\b/g, "").trim()
      : trimmedText;

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

  if (isGroup) {
    if (!mentionsBot) return;

    // ---- Group command path: allow commands without reply (still owner/allowlist gated) ----
    if (cleanedText.startsWith("/")) {
      if (!allowed) {
        await send(chatId, "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。");
        return;
      }
      // fall through to command parsing/dispatch below
    } else {
      // ---- Group explain path: requires reply ----
      if (!trimmedReplyText) {
        await send(chatId, "请回复一条告警消息再 @我，我才能解释。");
        return;
      }

      if (!allowed) {
        await send(chatId, "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。");
        return;
      }

      const ctx = {
        alert_raw: trimmedReplyText,
        symbol_context: { same_symbol_recent: "unknown" },
        market_context: { other_symbols_active: "unknown" },
      };

      const taskId = `tg_explain_${chatId}_${Date.now()}`;

      await send(chatId, "🧠 我看一下…");

      const prompt =
        "解释这条告警（facts-only）：\n" +
        "1) 发生了什么（用人话）\n" +
        "2) 关键结构特征（如量价背离/稳定币）\n" +
        "3) 可能原因（推断要写依据+置信度）\n" +
        "4) 下一步建议看什么（facts-only，不给交易建议）\n" +
        "禁止：价格预测、买卖建议、无依据故事。\n";

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

  if (!allowed) return;

  if (!isGroup) {
    if (trimmedReplyText) {
      lastAlertByChatId.set(chatId, { ts: Date.now(), rawText: trimmedReplyText });
    }

    if (trimmedText === "/help" || trimmedText === "help") {
      await send(chatId, "用法：回复一条告警，然后发“解释一下/？”即可。");
      return;
    }

    if (!trimmedText.startsWith("/")) {
      const rawAlert = trimmedReplyText || lastAlertByChatId.get(chatId)?.rawText || "";
      if (!rawAlert) {
        await send(chatId, "请先回复一条告警消息，然后发一句话（如：解释一下）。");
        return;
      }

      const ctx = {
        alert_raw: rawAlert,
        symbol_context: { same_symbol_recent: "unknown" },
        market_context: { other_symbols_active: "unknown" },
      };

      const taskId = `tg_explain_${chatId}_${Date.now()}`;

      await send(chatId, "🧠 我看一下…");

      const prompt =
        "解释这条告警（facts-only）：\n" +
        "1) 发生了什么（用人话）\n" +
        "2) 关键结构特征（如量价背离/稳定币）\n" +
        "3) 可能原因（推断要写依据+置信度）\n" +
        "4) 下一步建议看什么（facts-only，不给交易建议）\n" +
        "禁止：价格预测、买卖建议、无依据故事。\n";

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
