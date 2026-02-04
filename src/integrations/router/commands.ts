export type Cmd =
  | { kind: "ask"; q: string }
  | { kind: "analyze"; q: string }
  | { kind: "suggest"; q: string }
  | { kind: "status" }
  | { kind: "signals"; minutes: number | null }
  | { kind: "help" }
  | { kind: "news_hot"; limit: number | null }
  | { kind: "news_refresh"; limit: number | null }
  | { kind: "feeds_status" }
  | { kind: "feeds_asset"; symbol: string }
  | { kind: "feeds_source"; feedId: string }
  | { kind: "feeds_hotspots"; limit: number | null }
  | { kind: "feeds_ops"; limit: number | null }
  | { kind: "auth_add"; id: string }
  | { kind: "auth_del"; id: string }
  | { kind: "auth_list" }
  | { kind: "unknown"; raw: string };

function parseAfterCommand(t: string, cmd: string): string {
  // supports "/cmd xxx" or "/cmd\nxxx"
  const rest = t.slice(cmd.length).trimStart();
  return rest.trim();
}

function parseSignalWindow(raw: string): number | null {
  if (!raw) return 60;
  const match = raw.match(/^(\d+)\s*([mh])?$/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = String(match[2] || "m").toLowerCase();
  return unit === "h" ? n * 60 : n;
}

function parsePositiveInt(raw: string): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function parseCommand(text: string): Cmd {
  const t = (text || "").trim();

  if (t === "/status") return { kind: "status" };
  if (t.startsWith("/signals")) {
    const rest = parseAfterCommand(t, "/signals");
    return { kind: "signals", minutes: parseSignalWindow(rest) };
  }
  if (t === "/help") return { kind: "help" };

  if (t.startsWith("/news_refresh")) {
    const rest = parseAfterCommand(t, "/news_refresh");
    return { kind: "news_refresh", limit: parsePositiveInt(rest) };
  }
  if (t.startsWith("/news")) {
    const rest = parseAfterCommand(t, "/news");
    const parts = rest.split(/\s+/).filter(Boolean);
    if (parts[0] && parts[0].toLowerCase() === "refresh") {
      return { kind: "news_refresh", limit: parsePositiveInt(parts.slice(1).join(" ")) };
    }
    return { kind: "news_hot", limit: parsePositiveInt(parts[0] || "") };
  }

  if (t.startsWith("/feeds")) {
    const rest = parseAfterCommand(t, "/feeds");
    const parts = rest.split(/\s+/).filter(Boolean);
    const sub = (parts[0] || "status").toLowerCase();
    if (sub === "status") return { kind: "feeds_status" };
    if (sub === "asset") return { kind: "feeds_asset", symbol: parts[1] || "" };
    if (sub === "source") return { kind: "feeds_source", feedId: parts[1] || "" };
    if (sub === "hotspots") return { kind: "feeds_hotspots", limit: parsePositiveInt(parts[1] || "") };
    if (sub === "ops") return { kind: "feeds_ops", limit: parsePositiveInt(parts[1] || "") };
  }

  if (t.startsWith("/ask")) {
    const q = parseAfterCommand(t, "/ask");
    return { kind: "ask", q };
  }

  if (t.startsWith("/analyze")) {
    const q = parseAfterCommand(t, "/analyze");
    return { kind: "analyze", q };
  }

  if (t.startsWith("/suggest")) {
    const q = parseAfterCommand(t, "/suggest");
    return { kind: "suggest", q };
  }

  if (t.startsWith("/auth")) {
    const parts = t.split(/\s+/);
    if (parts[1] === "add" && parts[2]) return { kind: "auth_add", id: parts[2] };
    if (parts[1] === "del" && parts[2]) return { kind: "auth_del", id: parts[2] };
    if (parts[1] === "list") return { kind: "auth_list" };
  }

  return { kind: "unknown", raw: t };
}

// ===== LLM gateway commands =====
import { submitTask } from "../../core/internal_client.js";
import { errorText } from "../runtime/response_templates.js";

export async function handleAskCommand(ctx: {
  chatId: number | string;
  channel: string;
  taskIdPrefix: string;
  text: string;
  reply: (msg: string) => Promise<void>;
}) {
  const question = ctx.text.trim();
  if (!question) {
    await ctx.reply("Usage: /ask <your question>");
    return;
  }

  const taskId = `${ctx.taskIdPrefix}_ask_${Date.now()}`;

  await ctx.reply("🧠 Thinking…");

  try {
    const res = await submitTask({
      task_id: taskId,
      stage: "analyze",
      prompt: question,
      context: {
        source: ctx.channel,
        chat_id: ctx.chatId,
      },
    });

    if (!res.ok) {
      await ctx.reply(errorText(`Gateway error: ${res.error || "unknown"}`));
      return;
    }

    await ctx.reply(
      `🧠 *Analysis (facts-only)*\n\n${res.summary}`,
    );
  } catch (e: any) {
    await ctx.reply(errorText(`Exception: ${String(e.message || e)}`));
  }
}
