import http from "node:http";

import { FeishuWebhook } from "../channels/feishuWebhook.js";
import type { IntegrationContext } from "./context.js";
import { dispatchMessageEvent } from "./dispatch.js";
import { fromFeishu } from "./message_event.js";

type FeishuWebhookHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf-8") || "{}";
  return JSON.parse(raw);
}

function badRequest(res: http.ServerResponse, msg: string) {
  res.statusCode = 400;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: false, error: msg }));
}

function okJson(res: http.ServerResponse, body: any) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export type FeishuWebhookRuntime = {
  enabled: boolean;
  path: string;
  handler: FeishuWebhookHandler;
  sendText?: (chatId: string, text: string) => Promise<void>;
  sendImage?: (chatId: string, imagePath: string) => Promise<void>;
};

export function createFeishuWebhookHandler(
  ctx: IntegrationContext,
  client?: FeishuWebhook,
): FeishuWebhookRuntime {
  const { cfg } = ctx;
  const fcfg = cfg.channels?.feishu ?? {};
  const feishuEnabled = Boolean(fcfg.enabled);
  if (!feishuEnabled) {
    return {
      enabled: false,
      path: "",
      handler: async () => false,
    };
  }

  const ownerFeishuChatId = String(cfg.gateway?.owner?.feishu_chat_id ?? "");
  if (!ownerFeishuChatId) {
    throw new Error("Set gateway.owner.feishu_chat_id in config.yaml");
  }

  const feishu = client ?? new FeishuWebhook({
    app_id_env: String(fcfg.app_id_env || "FEISHU_APP_ID"),
    app_secret_env: String(fcfg.app_secret_env || "FEISHU_APP_SECRET"),
    verification_token_env: String(fcfg.verification_token_env || "FEISHU_VERIFICATION_TOKEN"),
    bot_user_id_env: String(fcfg.bot_user_id_env || "FEISHU_BOT_USER_ID"),
    bot_open_id_env: String(fcfg.bot_open_id_env || "FEISHU_BOT_OPEN_ID"),
    bot_name_env: String(fcfg.bot_name_env || "FEISHU_BOT_NAME"),
    base_url: String(fcfg.base_url || "https://open.feishu.cn/open-apis"),
  });

  const feishuEventPathRaw = String(fcfg.event_path || "/feishu/events");
  const feishuEventPath = feishuEventPathRaw.startsWith("/") ? feishuEventPathRaw : `/${feishuEventPathRaw}`;
  const handler: FeishuWebhookHandler = async (req, res) => {
    if (req.method !== "POST") return false;
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== feishuEventPath) return false;

    let body: any;
    try {
      body = await readJson(req);
    } catch {
      badRequest(res, "invalid_json");
      return true;
    }

    try {
      const out = await feishu.handleEvent(body);
      if (out.kind === "challenge") {
        okJson(res, { challenge: out.challenge });
        return true;
      }
      if (out.kind === "message") {
        const event = fromFeishu(out.msg);
        void dispatchMessageEvent(ctx, event, {
          sendText: feishu.sendMessage.bind(feishu),
        }).catch((e: any) => {
          console.error("[feishu][WARN] handleMessage failed:", String(e?.message || e));
        });
      }
      okJson(res, { code: 0 });
      return true;
    } catch (e: any) {
      badRequest(res, `feishu_handler_failed:${String(e?.message || e)}`);
      return true;
    }
  };

  return {
    enabled: true,
    path: feishuEventPath,
    handler,
    sendText: feishu.sendMessage.bind(feishu),
    sendImage: feishu.sendImage.bind(feishu),
  };
}

export function startFeishuWebhookServer(runtime: FeishuWebhookRuntime, host: string, port: number) {
  if (!runtime.enabled) {
    console.log("[feishu] disabled");
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const handled = await runtime.handler(req, res);
    if (!handled) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
    }
  });

  server.listen(port, host, () => {
    console.log(`[feishu] webhook listening on http://${host}:${port}${runtime.path}`);
  });

  return server;
}
