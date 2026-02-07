import { TelegramPolling } from "../integrations/channels/telegramPolling.js";
import { buildIntegrationContext } from "../integrations/runtime/context.js";
import { createFeishuWebhookHandler, startFeishuWebhookServer } from "../integrations/runtime/feishu.js";
import { ensureInternalApiUrl } from "../integrations/runtime/internal_url.js";
import { startNotifyServer } from "../integrations/runtime/notify_server.js";
import { startTelegramPolling } from "../integrations/runtime/telegram.js";
import { startCognitiveReminderLoop } from "../integrations/runtime/cognitive.js";

process.on("uncaughtException", (e: any) => console.error("[uncaughtException]", e?.stack || e));
process.on("unhandledRejection", (e: any) => console.error("[unhandledRejection]", e));

function toNumber(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

type SuperviseOpts = {
  delaysMs?: number[];
  resetAfterMs?: number;
  jitterMs?: number;
  openAfterFailures?: number;
  openMs?: number;
  maxRestartsPerHour?: number;
};

async function supervise(name: string, fn: () => Promise<void>, opts: SuperviseOpts = {}) {
  const delaysMs = opts.delaysMs || [1000, 2000, 5000, 10000, 30000];
  const resetAfterMs = opts.resetAfterMs ?? 60_000;
  const jitterMs = opts.jitterMs ?? 250;
  const openAfterFailures = opts.openAfterFailures ?? 5;
  const openMs = opts.openMs ?? 60_000;
  const maxRestartsPerHour = opts.maxRestartsPerHour ?? 30;
  const restartWindowMs = 60 * 60 * 1000;
  const restarts: number[] = [];
  let backoffIdx = 0;
  let consecutiveFailures = 0;
  while (true) {
    const startedAt = Date.now();
    try {
      await fn();
      console.warn(`[${name}] stopped; restarting soon`);
    } catch (e: any) {
      console.error(`[${name}] crashed:`, e?.stack || e?.message || e);
    }
    const uptime = Date.now() - startedAt;
    if (uptime > resetAfterMs) {
      backoffIdx = 0;
      consecutiveFailures = 0;
    }
    consecutiveFailures += 1;

    const now = Date.now();
    restarts.push(now);
    while (restarts.length && now - restarts[0] > restartWindowMs) restarts.shift();
    if (maxRestartsPerHour > 0 && restarts.length > maxRestartsPerHour) {
      console.error(`[${name}] restart limit exceeded (${restarts.length}/h); manual intervention required`);
      return;
    }

    if (openAfterFailures > 0 && consecutiveFailures >= openAfterFailures) {
      console.error(`[${name}] circuit open after ${consecutiveFailures} failures; cooling down ${openMs}ms`);
      consecutiveFailures = 0;
      backoffIdx = 0;
      await sleep(openMs);
      continue;
    }

    const baseDelay = delaysMs[Math.min(backoffIdx, delaysMs.length - 1)];
    backoffIdx = Math.min(backoffIdx + 1, delaysMs.length - 1);
    const jitter = Math.floor(Math.random() * jitterMs);
    await sleep(baseDelay + jitter);
  }
}

function toInt(value: any, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function readEnvInt(keys: string[], fallback: number): number {
  for (const key of keys) {
    if (process.env[key] != null) {
      return toInt(process.env[key], fallback);
    }
  }
  return fallback;
}

function buildSuperviseOpts(name: string): SuperviseOpts {
  const upper = name.toUpperCase();
  return {
    openAfterFailures: readEnvInt(
      [`CHAT_GATEWAY_CIRCUIT_OPEN_AFTER_${upper}`, "CHAT_GATEWAY_CIRCUIT_OPEN_AFTER"],
      5,
    ),
    openMs: readEnvInt(
      [`CHAT_GATEWAY_CIRCUIT_OPEN_MS_${upper}`, "CHAT_GATEWAY_CIRCUIT_OPEN_MS"],
      60_000,
    ),
    maxRestartsPerHour: readEnvInt(
      [`CHAT_GATEWAY_MAX_RESTARTS_${upper}_PER_HOUR`, "CHAT_GATEWAY_MAX_RESTARTS_PER_HOUR"],
      30,
    ),
    resetAfterMs: readEnvInt(
      [`CHAT_GATEWAY_SUPERVISE_RESET_MS_${upper}`, "CHAT_GATEWAY_SUPERVISE_RESET_MS"],
      60_000,
    ),
  };
}

function main() {
  const ctx = buildIntegrationContext();
  ensureInternalApiUrl(ctx.cfg);

  const gatewayHost = String(process.env.CHAT_GATEWAY_HOST || ctx.cfg.gateway?.server?.host || "127.0.0.1");
  const gatewayPort = toNumber(process.env.CHAT_GATEWAY_PORT ?? ctx.cfg.gateway?.server?.port, 8787);
  const token = String(process.env.CHAT_GATEWAY_TOKEN || "");

  const fcfg = ctx.cfg.channels?.feishu ?? {};
  const feishuHost = String(process.env.FEISHU_WEBHOOK_HOST || fcfg.listen_host || gatewayHost);
  const feishuPort = toNumber(process.env.FEISHU_WEBHOOK_PORT ?? fcfg.listen_port, gatewayPort + 1);

  let feishuRuntime: ReturnType<typeof createFeishuWebhookHandler>;
  try {
    feishuRuntime = createFeishuWebhookHandler(ctx);
  } catch (e: any) {
    console.error("[feishu][WARN] init failed:", e?.message || e);
    feishuRuntime = {
      enabled: false,
      path: "",
      handler: async () => false,
    };
  }

  const tcfg = ctx.cfg.channels?.telegram ?? {};
  const telegramEnabled = tcfg.enabled !== false;
  let telegram: TelegramPolling | undefined;
  if (telegramEnabled) {
    try {
      telegram = new TelegramPolling({
        bot_token_env: String(tcfg.bot_token_env || "TELEGRAM_BOT_TOKEN"),
        poll_interval_ms: Number(tcfg.poll_interval_ms || 1500),
      });
    } catch (e: any) {
      console.error("[telegram][WARN] init failed:", e?.message || e);
      telegram = undefined;
    }
  }

  const ownerFeishuChatId = String(ctx.cfg.gateway?.owner?.feishu_chat_id ?? "");

  const integrationsHost = String(process.env.INTEGRATIONS_HOST || gatewayHost);
  const integrationsPort = toNumber(process.env.INTEGRATIONS_PORT, gatewayPort + 2);

  const senders = {
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
  };

  startCognitiveReminderLoop({ storageDir: ctx.storageDir, senders });

  if (feishuRuntime.enabled) {
    void supervise("feishu", async () => {
      const server = startFeishuWebhookServer(feishuRuntime, feishuHost, feishuPort);
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server.on("error", reject);
        server.on("close", resolve);
      });
    }, buildSuperviseOpts("feishu"));
  } else {
    console.log("[feishu] disabled");
  }

  if (telegram) {
    void supervise("telegram", async () => {
      await startTelegramPolling(ctx, {
        telegram,
        feishuSendText: feishuRuntime.sendText,
        feishuSendImage: feishuRuntime.sendImage,
        feishuChatId: ownerFeishuChatId || undefined,
      });
    }, buildSuperviseOpts("telegram"));
  } else if (telegramEnabled) {
    console.log("[telegram] disabled (init failed)");
  } else {
    console.log("[telegram] disabled");
  }

  void supervise("notify", async () => {
    const server = startNotifyServer({
      host: integrationsHost,
      port: integrationsPort,
      token,
      cfg: ctx.cfg,
      loaded: ctx.loaded,
      storageDir: ctx.storageDir,
      senders,
    });
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.on("close", resolve);
    });
  }, buildSuperviseOpts("notify"));

  console.log("[chat-gateway] started (integrations-all)", {
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
