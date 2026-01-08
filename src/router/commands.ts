export type Cmd =
  | { kind: "ask"; q: string }
  | { kind: "analyze"; q: string }
  | { kind: "suggest"; q: string }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "auth_add"; id: string }
  | { kind: "auth_del"; id: string }
  | { kind: "auth_list" }
  | { kind: "unknown"; raw: string };

function parseAfterCommand(t: string, cmd: string): string {
  // supports "/cmd xxx" or "/cmd\nxxx"
  const rest = t.slice(cmd.length).trimStart();
  return rest.trim();
}

export function parseCommand(text: string): Cmd {
  const t = (text || "").trim();

  if (t === "/status") return { kind: "status" };
  if (t === "/help") return { kind: "help" };

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
import { submitTask } from "../internal_client";

export async function handleAskCommand(ctx: {
  chatId: number | string;
  text: string;
  reply: (msg: string) => Promise<void>;
}) {
  const question = ctx.text.trim();
  if (!question) {
    await ctx.reply("Usage: /ask <your question>");
    return;
  }

  const taskId = `tg_ask_${Date.now()}`;

  await ctx.reply("🧠 Thinking…");

  try {
    const res = await submitTask({
      task_id: taskId,
      stage: "analyze",
      prompt: question,
      context: {
        source: "telegram",
        chat_id: ctx.chatId,
      },
    });

    if (!res.ok) {
      await ctx.reply(`❌ Gateway error: ${res.error || "unknown"}`);
      return;
    }

    await ctx.reply(
      `🧠 *Analysis (facts-only)*\n\n${res.summary}`,
    );
  } catch (e: any) {
    await ctx.reply(`❌ Exception: ${String(e.message || e)}`);
  }
}