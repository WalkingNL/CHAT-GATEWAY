import { buildIntegrationContext } from "../integrations/runtime/context.js";
import { ensureInternalApiUrl } from "../integrations/runtime/internal_url.js";
import { createFeishuWebhookHandler, startFeishuWebhookServer } from "../integrations/runtime/feishu.js";

process.on("uncaughtException", (e: any) => console.error("[uncaughtException]", e?.stack || e));
process.on("unhandledRejection", (e: any) => console.error("[unhandledRejection]", e));

function toNumber(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function main() {
  const ctx = buildIntegrationContext();
  ensureInternalApiUrl(ctx.cfg);

  const fcfg = ctx.cfg.channels?.feishu ?? {};
  const gatewayHost = String(process.env.CHAT_GATEWAY_HOST || ctx.cfg.gateway?.server?.host || "127.0.0.1");
  const gatewayPort = toNumber(process.env.CHAT_GATEWAY_PORT ?? ctx.cfg.gateway?.server?.port, 8787);

  const host = String(process.env.FEISHU_WEBHOOK_HOST || fcfg.listen_host || gatewayHost);
  const port = toNumber(process.env.FEISHU_WEBHOOK_PORT ?? fcfg.listen_port, gatewayPort + 1);

  const runtime = createFeishuWebhookHandler(ctx);
  startFeishuWebhookServer(runtime, host, port);
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
