import { execFileLimited } from "../runtime/exec_limiter.js";

export interface FeishuCfg {
  app_id_env: string;
  app_secret_env: string;
  verification_token_env: string;
  bot_user_id_env?: string;
  bot_open_id_env?: string;
  bot_name_env?: string;
  base_url?: string;
}

export type FeishuMsg = {
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

export type FeishuEventResult =
  | { kind: "challenge"; challenge: string }
  | { kind: "message"; msg: FeishuMsg }
  | { kind: "ignore"; reason: string };

type CurlMethod = "GET" | "POST";

export class FeishuWebhook {
  private appId: string;
  private appSecret: string;
  private verifyToken: string;
  private botUserId: string;
  private botOpenId: string;
  private botName: string;
  private baseUrl: string;
  private tenantToken: string | null = null;
  private tenantTokenExpireAt = 0;

  constructor(private cfg: FeishuCfg) {
    const appId = String(process.env[cfg.app_id_env] || "").trim();
    const appSecret = String(process.env[cfg.app_secret_env] || "").trim();
    const verifyToken = String(process.env[cfg.verification_token_env] || "").trim();
    if (!appId) throw new Error(`Missing env ${cfg.app_id_env}`);
    if (!appSecret) throw new Error(`Missing env ${cfg.app_secret_env}`);
    if (!verifyToken) throw new Error(`Missing env ${cfg.verification_token_env}`);

    this.appId = appId;
    this.appSecret = appSecret;
    this.verifyToken = verifyToken;
    this.botUserId = String(process.env[cfg.bot_user_id_env || "FEISHU_BOT_USER_ID"] || "").trim();
    this.botOpenId = String(process.env[cfg.bot_open_id_env || "FEISHU_BOT_OPEN_ID"] || "").trim();
    this.botName = String(process.env[cfg.bot_name_env || "FEISHU_BOT_NAME"] || "").trim();
    this.baseUrl = String(cfg.base_url || "https://open.feishu.cn/open-apis").trim();
  }

  private async curlJson(
    url: string,
    method: CurlMethod,
    body?: any,
    headers?: Record<string, string>,
    maxTimeSec = 45,
  ): Promise<any> {
    const args: string[] = ["-4", "-sS", "--connect-timeout", "5", "--max-time", String(maxTimeSec)];
    if (method === "POST") {
      args.push("-X", "POST", "-H", "Content-Type: application/json");
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          args.push("-H", `${k}: ${v}`);
        }
      }
      args.push("-d", JSON.stringify(body ?? {}));
    } else if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        args.push("-H", `${k}: ${v}`);
      }
    }
    args.push(url);

    const { stdout } = await execFileLimited("feishu", "curl", args);
    return JSON.parse(stdout);
  }

  private async getTenantToken(): Promise<string> {
    const now = Date.now();
    if (this.tenantToken && now < this.tenantTokenExpireAt - 60_000) return this.tenantToken;

    const url = `${this.baseUrl}/auth/v3/tenant_access_token/internal/`;
    const json = await this.curlJson(url, "POST", {
      app_id: this.appId,
      app_secret: this.appSecret,
    });

    if (json?.code !== 0 || !json?.tenant_access_token) {
      throw new Error(`feishu token failed: ${JSON.stringify(json).slice(0, 200)}`);
    }

    const expireSec = Number(json.expire || 0);
    this.tenantToken = String(json.tenant_access_token);
    this.tenantTokenExpireAt = now + expireSec * 1000;
    return this.tenantToken;
  }

  async sendMessage(chatId: string, text: string) {
    const token = await this.getTenantToken();
    const url = `${this.baseUrl}/im/v1/messages?receive_id_type=chat_id`;
    const body = {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    };
    const json = await this.curlJson(url, "POST", body, { Authorization: `Bearer ${token}` });
    if (json?.code !== 0) {
      throw new Error(`feishu sendMessage failed: ${JSON.stringify(json).slice(0, 200)}`);
    }
  }

  private async uploadImage(imagePath: string): Promise<string> {
    const token = await this.getTenantToken();
    const url = `${this.baseUrl}/im/v1/images`;
    const args: string[] = ["-4", "-sS", "--connect-timeout", "5", "--max-time", "45", "-X", "POST"];
    args.push("-H", `Authorization: Bearer ${token}`);
    args.push("-F", "image_type=message");
    args.push("-F", `image=@${imagePath}`);
    args.push(url);

    const { stdout } = await execFileLimited("feishu", "curl", args);
    const json = JSON.parse(stdout);
    const key = json?.data?.image_key;
    if (json?.code !== 0 || !key) {
      throw new Error(`feishu uploadImage failed: ${JSON.stringify(json).slice(0, 200)}`);
    }
    return String(key);
  }

  async sendImage(chatId: string, imagePath: string) {
    const imageKey = await this.uploadImage(imagePath);
    const token = await this.getTenantToken();
    const url = `${this.baseUrl}/im/v1/messages?receive_id_type=chat_id`;
    const body = {
      receive_id: chatId,
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey }),
    };
    const json = await this.curlJson(url, "POST", body, { Authorization: `Bearer ${token}` });
    if (json?.code !== 0) {
      throw new Error(`feishu sendImage failed: ${JSON.stringify(json).slice(0, 200)}`);
    }
  }

  async handleEvent(body: any): Promise<FeishuEventResult> {
    if (!body || typeof body !== "object") return { kind: "ignore", reason: "invalid_body" };
    if (body.encrypt) return { kind: "ignore", reason: "encrypted_payload" };

    if (body.type === "url_verification") {
      if (!this.verifyToken || body.token !== this.verifyToken) {
        return { kind: "ignore", reason: "token_mismatch" };
      }
      return { kind: "challenge", challenge: String(body.challenge || "") };
    }

    const token = body?.header?.token || body?.token || "";
    if (this.verifyToken && token !== this.verifyToken) {
      return { kind: "ignore", reason: "token_mismatch" };
    }

    const eventType = String(body?.header?.event_type || "");
    if (eventType !== "im.message.receive_v1") {
      return { kind: "ignore", reason: "unsupported_event" };
    }

    const sender = body?.event?.sender || {};
    if (String(sender?.sender_type || "") === "bot") {
      return { kind: "ignore", reason: "from_bot" };
    }

    const message = body?.event?.message || {};
    const msgType = String(message?.message_type || message?.msg_type || "");
    if (msgType !== "text") {
      return { kind: "ignore", reason: "non_text" };
    }

    const chatId = String(message?.chat_id || "");
    const userId = String(sender?.sender_id?.user_id || sender?.sender_id?.open_id || "");
    const messageId = String(message?.message_id || "");
    const rawText = this.parseContentText(message?.content ?? message?.body?.content, msgType);
    const text = this.stripMentions(rawText);
    if (!chatId || !userId || !text) {
      return { kind: "ignore", reason: "missing_fields" };
    }

    const chatType = String(message?.chat_type || "");
    const isGroup = !(chatType === "p2p" || chatType === "private");

    let replyText = "";
    const parentId = String(message?.parent_id || message?.root_id || "");
    if (parentId) {
      replyText = await this.fetchMessageText(parentId);
    }

    const mentionsBot = this.detectMentionsBot(message, rawText);

    return {
      kind: "message",
      msg: { chatId, chatType, userId, messageId, replyToId: parentId, text, replyText, isGroup, mentionsBot },
    };
  }

  private parseContentText(content: any, msgType: string): string {
    if (!content) return "";
    if (typeof content === "string") {
      try {
        const obj = JSON.parse(content);
        if (obj && typeof obj.text === "string") return obj.text;
        return String(content);
      } catch {
        return String(content);
      }
    }
    if (typeof content === "object" && typeof content.text === "string") {
      return content.text;
    }
    if (msgType === "text") return "";
    return "";
  }

  private stripMentions(text: string): string {
    let out = String(text || "");
    out = out.replace(/<at[^>]*>.*?<\/at>/gi, " ");
    out = out.replace(/@_user_\d+/gi, " ");
    return out.trim();
  }

  private detectMentionsBot(message: any, rawText: string): boolean {
    const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
    const botUserId = this.botUserId;
    const botOpenId = this.botOpenId;
    const botName = this.botName.toLowerCase();

    const byList = mentions.some((m: any) => {
      const id = m?.id || {};
      if (botUserId && id?.user_id === botUserId) return true;
      if (botOpenId && id?.open_id === botOpenId) return true;
      if (botName && String(m?.name || "").toLowerCase() === botName) return true;
      return false;
    });

    if (byList) return true;

    if (botUserId && rawText.includes(botUserId)) return true;
    if (botOpenId && rawText.includes(botOpenId)) return true;
    if (botName && rawText.toLowerCase().includes(`@${botName}`)) return true;
    if (botName) {
      const tagRe = new RegExp(`<at[^>]*>\\s*${this.escapeRegExp(botName)}\\s*<\\/at>`, "i");
      if (tagRe.test(rawText)) return true;
    }
    return false;
  }

  private escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private async fetchMessageText(messageId: string): Promise<string> {
    try {
      const token = await this.getTenantToken();
      const url = `${this.baseUrl}/im/v1/messages/${messageId}`;
      const json = await this.curlJson(url, "GET", undefined, { Authorization: `Bearer ${token}` }, 8);
      const dataMsg = json?.data?.message || json?.data?.items?.[0] || json?.data?.items || null;
      const msgType = String(dataMsg?.msg_type || dataMsg?.message_type || "");
      const content = dataMsg?.body?.content ?? dataMsg?.content;
      const raw = this.parseContentText(content, msgType);
      return this.stripMentions(raw);
    } catch {
      return "";
    }
  }
}
