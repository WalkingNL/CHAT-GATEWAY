import { handleAskCommand, parseCommand } from "./commands.js";
import { appendLedger } from "../audit/ledger.js";
import { getStatusFacts } from "./context.js";
import { RateLimiter } from "../rateLimit/limiter.js";
import { loadAuth, saveAuth } from "../auth/store.js";
import type { LLMProvider, ChatMessage } from "../providers/base.js";
import { submitTask } from "../internal_client.js";

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
  allowlistMode: "owner_only" | "auth";
  provider: LLMProvider;
  limiter: RateLimiter;
  chatId: string;
  userId: string;
  text: string;
  send: (chatId: string, text: string) => Promise<void>;
}) {
  const { storageDir, ownerChatId, allowlistMode, chatId, userId, text, send, provider, limiter } = opts;

  const authState = loadAuth(storageDir, ownerChatId);
  const isOwner = chatId === ownerChatId;
  const allowed = allowlistMode === "owner_only" ? isOwner : authState.allowed.includes(chatId);
  if (!allowed) return;

  const cmd = parseCommand(text);

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

  // Rate limit only for LLM commands
  if (cmd.kind === "ask" || cmd.kind === "analyze" || cmd.kind === "suggest") {
    if (!limiter.allow(chatId)) {
      await send(chatId, "rate limited (facts-only)");
      appendLedger(storageDir, { ...baseAudit, cmd: cmd.kind, rate_limited: true });
      return;
    }
  }

  // ---- /ask: freeform answer ----
  if (cmd.kind === "ask") {
    if (!cmd.q) {
      await send(chatId, "usage: /ask <question>");
      return;
    }

    const messages: ChatMessage[] = [
      { role: "system", content: "You are a rigorous engineering assistant. Facts-only. No predictions. No risky actions." },
      { role: "user", content: cmd.q },
    ];

    const t0 = Date.now();
    let out = "";
    try {
      out = await provider.generate({ messages });
    } catch (e: any) {
      out = `LLM unavailable: ${String(e?.message || e)}`;
    }
    const latency = Date.now() - t0;

    await send(chatId, clip(out, 3500));
    appendLedger(storageDir, { ...baseAudit, cmd: "ask", latency_ms: latency, out_tail: out.slice(-800) });
    return;
  }

  // ---- /analyze: structured facts-only analysis ----
  if (cmd.kind === "analyze") {
    if (!cmd.q) {
      await send(chatId, "usage: /analyze <incident description>");
      return;
    }

    const t0 = Date.now();
    let out = "";
    try {
      out = await provider.generate({ messages: buildAnalyzeMessages(cmd.q) });
    } catch (e: any) {
      out = `LLM unavailable: ${String(e?.message || e)}`;
    }
    const latency = Date.now() - t0;

    const reply = formatAnalyzeReply(out);
    await send(chatId, reply);
    appendLedger(storageDir, { ...baseAudit, cmd: "analyze", latency_ms: latency, out_tail: out.slice(-1200) });
    return;
  }

  // ---- /suggest: JSON suggestion -> TG summary ----
  if (cmd.kind === "suggest") {
    if (!cmd.q) {
      await send(chatId, "usage: /suggest <incident description>");
      return;
    }

    const t0 = Date.now();
    let raw = "";
    try {
      raw = await provider.generate({ messages: buildSuggestMessages(cmd.q) });
    } catch (e: any) {
      const msg = `LLM unavailable: ${String(e?.message || e)}`;
      await send(chatId, msg);
      appendLedger(storageDir, { ...baseAudit, cmd: "suggest", latency_ms: Date.now() - t0, ok: false, error: msg });
      return;
    }

    const latency = Date.now() - t0;
    const obj = safeJsonParse<SuggestObj>(raw);

    if (!obj) {
      // Still reply, but indicate failure; keep raw_tail for audit
      const reply = [
        "🛠 DeepSeek Suggestion",
        "",
        "Result: INVALID (LLM did not return JSON).",
        "raw_tail:",
        "```",
        clip(raw, 1200),
        "```",
      ].join("\n");

      await send(chatId, reply);
      appendLedger(storageDir, { ...baseAudit, cmd: "suggest", latency_ms: latency, ok: false, error: "non_json", raw_tail: raw.slice(-1200) });
      return;
    }

    const reply = formatSuggestReply(obj);
    await send(chatId, clip(reply, 3500));

    appendLedger(storageDir, {
      ...baseAudit,
      cmd: "suggest",
      latency_ms: latency,
      ok: true,
      files_touched: obj.files_touched || [],
      verify_cmds: obj.verify_cmds || [],
      warnings: obj.warnings || [],
      patch_tail: String(obj.suggested_patch || "").slice(-800),
    });
    return;
  }

  // unknown
  await send(chatId, "unknown command. /help");
  appendLedger(storageDir, { ...baseAudit, cmd: "unknown" });
}