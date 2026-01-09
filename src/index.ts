import fs from "node:fs";
import { loadConfig } from "./config/loadConfig.js";
import { loadAllConfig } from "./config/index.js";
import { TelegramPolling } from "./channels/telegramPolling.js";
import { DeepSeekProvider } from "./providers/deepseek.js";
import { RateLimiter } from "./rateLimit/limiter.js";
import { handleMessage } from "./router/router.js";
import { startInternalApi } from "./internal_api.js";

process.on("uncaughtException", (e: any) => console.error("[uncaughtException]", e?.stack || e));
process.on("unhandledRejection", (e: any) => console.error("[unhandledRejection]", e));

async function main() {
  const cfg = loadConfig("config.yaml");
  const loaded = loadAllConfig();
  console.log("[config]", {
    policyOk: loaded.meta.policyOk,
    projectsCount: loaded.meta.projectsCount,
    project_ids: Object.keys(loaded.projects),
  });
  if (loaded.meta.errors.length) {
    console.warn("[config][WARN]", loaded.meta.errors.join("; "));
  }

  const storageDir = cfg.gateway?.storage?.dir ?? "./data";
  fs.mkdirSync(storageDir, { recursive: true });

  const ownerChatId = String(cfg.gateway?.owner?.telegram_chat_id ?? "");
  if (!ownerChatId || ownerChatId === "YOUR_OWNER_CHAT_ID") {
    throw new Error("Set gateway.owner.telegram_chat_id in config.yaml");
  }

  const allowlistMode = (cfg.channels?.telegram?.allowlist_mode ?? "auth") as "owner_only" | "auth";

  const perUser = Number(cfg.gateway?.rate_limit?.per_user_per_min ?? 10);
  const global = Number(cfg.gateway?.rate_limit?.global_per_min ?? 30);
  const limiter = new RateLimiter(perUser, global);

  const pCfg = cfg.gateway?.providers?.deepseek ?? {};
  const provider = new DeepSeekProvider(
    String(process.env.DEEPSEEK_API_KEY || ""),
    String(pCfg.base_url || "https://api.deepseek.com"),
    String(pCfg.model || "deepseek-chat"),
    Number(pCfg.max_tokens || 800),
    Number(pCfg.temperature || 0.2),
  );

  const tcfg = cfg.channels?.telegram ?? {};
  const tg = new TelegramPolling({
    bot_token_env: String(tcfg.bot_token_env || "TELEGRAM_BOT_TOKEN"),
    poll_interval_ms: Number(tcfg.poll_interval_ms || 1500),
  });

  console.log("[chat-gateway] started");

  const host = String(process.env.CHAT_GATEWAY_HOST || "127.0.0.1");
  const port = Number(process.env.CHAT_GATEWAY_PORT || 8787);
  const token = String(process.env.CHAT_GATEWAY_TOKEN || "");

  startInternalApi({
    host,
    port,
    token,
    storageDir,
    provider,
  });

  while (true) {
    let msgs: any[] = [];
    try {
      msgs = await tg.pollOnce();
    } catch (e: any) {
      console.error("[tg][WARN] pollOnce failed:", String(e?.message || e));
      msgs = [];
    }

    for (const m of msgs) {
      try {
        await handleMessage({
          storageDir,
          ownerChatId,
          allowlistMode,
          provider,
          limiter,
          chatId: m.chatId,
          userId: m.userId,
          text: m.text,
          replyText: m.replyText,
          isGroup: m.isGroup,
          mentionsBot: m.mentionsBot,
          send: tg.sendMessage.bind(tg),
        });
      } catch (e: any) {
        console.error("[tg][WARN] handleMessage failed:", String(e?.message || e));
      }
    }
    await new Promise(r => setTimeout(r, Number(tcfg.poll_interval_ms || 1500)));
  }
}

function dumpUnknown(e: any) {
  try {
    if (e instanceof Error) return e.stack || e.message;
    // 尽可能把 null-prototype 对象打印出来
    return JSON.stringify(e, Object.getOwnPropertyNames(e));
  } catch {
    return String(e);
  }
}

main().catch((e: any) => {
  console.error("[FATAL]", dumpUnknown(e));
  process.exit(1);
});
