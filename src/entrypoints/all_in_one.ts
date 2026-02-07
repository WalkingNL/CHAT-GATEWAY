import { buildProvider } from "../core/provider_factory.js";
import { startInternalApi } from "../core/internal_api.js";
import { TelegramPolling } from "../integrations/channels/telegramPolling.js";
import { buildIntegrationContext } from "../integrations/runtime/context.js";
import { createFeishuWebhookHandler, startFeishuWebhookServer } from "../integrations/runtime/feishu.js";
import { ensureInternalApiUrl } from "../integrations/runtime/internal_url.js";
import { startNotifyServer } from "../integrations/runtime/notify_server.js";
import { startTelegramPolling } from "../integrations/runtime/telegram.js";

process.on("uncaughtException", (e: any) => console.error("[uncaughtException]", e?.stack || e));
process.on("unhandledRejection", (e: any) => console.error("[unhandledRejection]", e));

function toNumber(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function main() {
  const ctx = buildIntegrationContext();
  const provider = buildProvider(ctx.cfg);

  const gatewayHost = String(process.env.CHAT_GATEWAY_HOST || ctx.cfg.gateway?.server?.host || "127.0.0.1");
  const gatewayPort = toNumber(process.env.CHAT_GATEWAY_PORT ?? ctx.cfg.gateway?.server?.port, 8787);
  const token = String(process.env.CHAT_GATEWAY_TOKEN || "");

  startInternalApi({
    host: gatewayHost,
    port: gatewayPort,
    token,
    storageDir: ctx.storageDir,
    provider,
  });

  if (!process.env.CHAT_GATEWAY_INTERNAL_URL) {
    process.env.CHAT_GATEWAY_INTERNAL_URL = `http://${gatewayHost}:${gatewayPort}`;
  }
  ensureInternalApiUrl(ctx.cfg);

  const fcfg = ctx.cfg.channels?.feishu ?? {};
  const feishuHost = String(process.env.FEISHU_WEBHOOK_HOST || fcfg.listen_host || gatewayHost);
  const feishuPort = toNumber(process.env.FEISHU_WEBHOOK_PORT ?? fcfg.listen_port, gatewayPort + 1);

  const feishuRuntime = createFeishuWebhookHandler(ctx);
  startFeishuWebhookServer(feishuRuntime, feishuHost, feishuPort);

  const tcfg = ctx.cfg.channels?.telegram ?? {};
  const telegramEnabled = tcfg.enabled !== false;
  const telegram = telegramEnabled
    ? new TelegramPolling({
        bot_token_env: String(tcfg.bot_token_env || "TELEGRAM_BOT_TOKEN"),
        poll_interval_ms: Number(tcfg.poll_interval_ms || 1500),
      })
    : undefined;

  const ownerFeishuChatId = String(ctx.cfg.gateway?.owner?.feishu_chat_id ?? "");

  void startTelegramPolling(ctx, {
    telegram,
    feishuSendText: feishuRuntime.sendText,
    feishuSendImage: feishuRuntime.sendImage,
    feishuChatId: ownerFeishuChatId || undefined,
  });

  const integrationsHost = String(process.env.INTEGRATIONS_HOST || gatewayHost);
  const integrationsPort = toNumber(process.env.INTEGRATIONS_PORT, gatewayPort + 2);

  startNotifyServer({
    host: integrationsHost,
    port: integrationsPort,
    token,
    cfg: ctx.cfg,
    loaded: ctx.loaded,
    storageDir: ctx.storageDir,
    senders: {
      telegram: telegram
        ? {
            sendText: telegram.sendMessage.bind(telegram),
            sendImage: telegram.sendPhoto.bind(telegram),
          }
        : undefined,
      feishu: feishuRuntime.enabled && feishuRuntime.sendText && feishuRuntime.sendImage
        ? {
            sendText: feishuRuntime.sendText,
            sendImage: feishuRuntime.sendImage,
          }
        : undefined,
    },
  });

  console.log("[chat-gateway] started (all-in-one)", {
    core: { host: gatewayHost, port: gatewayPort },
    feishu: feishuRuntime.enabled ? { host: feishuHost, port: feishuPort } : "disabled",
    notify: { host: integrationsHost, port: integrationsPort },
    telegram: telegramEnabled ? "polling" : "disabled",
  });
}

function dumpUnknown(e: any) {
  try {
    if (e instanceof Error) return e.stack || e.message;
    return JSON.stringify(e, Object.getOwnPropertyNames(e));
  } catch {
    return String(e);
  }
}

try {
  main();
} catch (e: any) {
  console.error("[FATAL]", dumpUnknown(e));
  process.exit(1);
}
