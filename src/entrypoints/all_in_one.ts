import http from "node:http";

import { createInternalApiHandler } from "../core/internal_api.js";
import { buildProvider } from "../core/provider_factory.js";
import { buildIntegrationContext } from "../integrations/runtime/context.js";
import { ensureInternalApiUrl } from "../integrations/runtime/internal_url.js";
import { createFeishuWebhookHandler } from "../integrations/runtime/feishu.js";
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
  const host = String(process.env.CHAT_GATEWAY_HOST || ctx.cfg.gateway?.server?.host || "127.0.0.1");
  const port = toNumber(process.env.CHAT_GATEWAY_PORT ?? ctx.cfg.gateway?.server?.port, 8787);
  const token = String(process.env.CHAT_GATEWAY_TOKEN || "");

  if (!process.env.CHAT_GATEWAY_INTERNAL_URL) {
    process.env.CHAT_GATEWAY_INTERNAL_URL = `http://${host}:${port}`;
  }
  ensureInternalApiUrl(ctx.cfg);

  const internalHandler = createInternalApiHandler({
    host,
    port,
    token,
    storageDir: ctx.storageDir,
    provider,
  });
  const feishuRuntime = createFeishuWebhookHandler(ctx);

  const server = http.createServer(async (req, res) => {
    if (feishuRuntime.enabled) {
      const handled = await feishuRuntime.handler(req, res);
      if (handled) return;
    }
    await internalHandler(req, res);
  });

  server.listen(port, host, () => {
    console.log(`[core] internal API listening on http://${host}:${port}`);
    if (feishuRuntime.enabled) {
      console.log(`[feishu] webhook path active at ${feishuRuntime.path}`);
    }
  });

  void startTelegramPolling(ctx);
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
