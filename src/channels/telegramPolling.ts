import { execFileSync } from "node:child_process";

export interface TelegramCfg {
  bot_token_env: string;
  poll_interval_ms: number;
}

export type TelegramMsg = {
  chatId: string;
  text: string;
  userId: string;
  replyText: string;
  isGroup: boolean;
  mentionsBot: boolean;
};

export class TelegramPolling {
  private offset = 0;
  private token: string;

  constructor(private cfg: TelegramCfg) {
    const t = process.env[cfg.bot_token_env] || "";
    if (!t) throw new Error(`Missing env ${cfg.bot_token_env}`);
    this.token = t;
  }

  api(path: string) {
    return `https://api.telegram.org/bot${this.token}/${path}`;
  }

  private curlJson(url: string, method: "GET" | "POST", body?: any): any {
    // Use curl -4 for stability; apply timeouts to avoid hanging
    const args: string[] = ["-4", "-sS", "--connect-timeout", "5", "--max-time", "45"];
    if (method === "POST") {
      args.push("-X", "POST", "-H", "Content-Type: application/json");
      args.push("-d", JSON.stringify(body ?? {}));
    }
    args.push(url);

    const out = execFileSync("curl", args, { encoding: "utf-8" });
    return JSON.parse(out);
  }

  async sendMessage(chatId: string, text: string) {
    const json = this.curlJson(this.api("sendMessage"), "POST", { chat_id: chatId, text });
    if (!json?.ok) {
      throw new Error(`telegram sendMessage failed: ${JSON.stringify(json).slice(0, 200)}`);
    }
  }

  async pollOnce(): Promise<TelegramMsg[]> {
    const url = this.api(`getUpdates?timeout=25&offset=${this.offset}`);
    const json = this.curlJson(url, "GET");
    if (!json?.ok) return [];

    const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || "SoliaNLBot");
    const mentionToken = botUsername
      ? (botUsername.startsWith("@") ? botUsername : `@${botUsername}`)
      : "";

    const out: TelegramMsg[] = [];
    for (const u of json.result ?? []) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const m = u.message || u.edited_message;
      if (!m?.text) continue;

      const chatId = String(m.chat?.id ?? "");
      const userId = String(m.from?.id ?? chatId);
      const text = String(m.text || "");
      const replyText = String(m.reply_to_message?.text || "");
      const isGroup = m.chat?.type !== "private";
      const mentionsBot = mentionToken ? text.includes(mentionToken) : false;
      out.push({ chatId, userId, text, replyText, isGroup, mentionsBot });
    }
    return out;
  }
}
