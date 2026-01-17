import { execFileLimited } from "../runtime/exec_limiter.js";

export interface TelegramCfg {
  bot_token_env: string;
  poll_interval_ms: number;
}

export type TelegramMsg = {
  chatId: string;
  chatType: string;
  text: string;
  userId: string;
  messageId: string;
  replyToId: string;
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

  private async curlJson(url: string, method: "GET" | "POST", body?: any): Promise<any> {
    // Use curl -4 for stability; apply timeouts to avoid hanging
    const args: string[] = ["-4", "-sS", "--connect-timeout", "5", "--max-time", "45"];
    if (method === "POST") {
      args.push("-X", "POST", "-H", "Content-Type: application/json");
      args.push("-d", JSON.stringify(body ?? {}));
    }
    args.push(url);

    const { stdout } = await execFileLimited("telegram", "curl", args);
    return JSON.parse(stdout);
  }

  async sendMessage(chatId: string, text: string) {
    const json = await this.curlJson(this.api("sendMessage"), "POST", { chat_id: chatId, text });
    if (!json?.ok) {
      throw new Error(`telegram sendMessage failed: ${JSON.stringify(json).slice(0, 200)}`);
    }
  }

  async sendPhoto(chatId: string, imagePath: string, caption?: string) {
    const url = this.api("sendPhoto");
    const args: string[] = ["-4", "-sS", "--connect-timeout", "5", "--max-time", "45", "-X", "POST"];
    args.push("-F", `chat_id=${chatId}`);
    if (caption) {
      args.push("-F", `caption=${caption}`);
    }
    args.push("-F", `photo=@${imagePath}`);
    args.push(url);
    const { stdout } = await execFileLimited("telegram", "curl", args);
    const json = JSON.parse(stdout);
    if (!json?.ok) {
      throw new Error(`telegram sendPhoto failed: ${JSON.stringify(json).slice(0, 200)}`);
    }
  }

  async pollOnce(): Promise<TelegramMsg[]> {
    const url = this.api(`getUpdates?timeout=25&offset=${this.offset}`);
    const json = await this.curlJson(url, "GET");
    if (!json?.ok) return [];

    const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || "SoliaNLBot");
    const mentionToken = botUsername
      ? (botUsername.startsWith("@") ? botUsername : `@${botUsername}`)
      : "";
    const mentionTokenLower = mentionToken.toLowerCase();

    const out: TelegramMsg[] = [];
    for (const u of json.result ?? []) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const m = u.message || u.edited_message;
      if (!m?.text) continue;

      const chatId = String(m.chat?.id ?? "");
      const userId = String(m.from?.id ?? chatId);
      const messageId = String(m.message_id ?? "");
      const replyToId = String(m.reply_to_message?.message_id ?? "");
      const text = String(m.text || "");
      const replyText = String(m.reply_to_message?.text || "");
      const chatType = String(m.chat?.type || "");
      const isGroup = chatType !== "private";
      const entities = Array.isArray(m.entities) ? m.entities : [];
      const mentionByEntity = mentionToken
        ? entities.some((e: any) => {
            if (e?.type === "mention") {
              if (typeof e.offset !== "number" || typeof e.length !== "number") return false;
              const slice = text.slice(e.offset, e.offset + e.length);
              return slice.toLowerCase() === mentionTokenLower;
            }
            if (e?.type === "text_mention" && e?.user?.username) {
              const u = String(e.user.username);
              return (`@${u}`.toLowerCase() === mentionTokenLower);
            }
            return false;
          })
        : false;
      const mentionsBot = mentionToken
        ? text.toLowerCase().includes(mentionTokenLower) || mentionByEntity
        : false;
      out.push({ chatId, chatType, userId, messageId, replyToId, text, replyText, isGroup, mentionsBot });
    }
    return out;
  }
}
