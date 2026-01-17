import { TelegramPolling } from "../channels/telegramPolling.js";
import { handleMessage } from "../router/router.js";
import { handleChartIfAny, handleFeedbackIfAny } from "./handlers.js";
import type { IntegrationContext } from "./context.js";

export async function startTelegramPolling(ctx: IntegrationContext) {
  const { cfg, loaded, storageDir, limiter } = ctx;
  const tcfg = cfg.channels?.telegram ?? {};
  const telegramEnabled = tcfg.enabled !== false;
  if (!telegramEnabled) {
    console.log("[telegram] disabled");
    return;
  }

  const ownerTelegramChatId = String(cfg.gateway?.owner?.telegram_chat_id ?? "");
  const ownerTelegramUserId = String(process.env.OWNER_TELEGRAM_USER_ID || "");
  if (!ownerTelegramChatId || ownerTelegramChatId === "YOUR_OWNER_CHAT_ID") {
    throw new Error("Set gateway.owner.telegram_chat_id in config.yaml");
  }

  const allowlistModeTelegram = (tcfg.allowlist_mode ?? "auth") as "owner_only" | "auth";

  const tg = new TelegramPolling({
    bot_token_env: String(tcfg.bot_token_env || "TELEGRAM_BOT_TOKEN"),
    poll_interval_ms: Number(tcfg.poll_interval_ms || 1500),
  });

  while (telegramEnabled) {
    let msgs: any[] = [];
    try {
      msgs = await tg.pollOnce();
    } catch (e: any) {
      console.error("[tg][WARN] pollOnce failed:", String(e?.message || e));
      msgs = [];
    }

    for (const m of msgs) {
      try {
        if (await handleFeedbackIfAny({
          storageDir,
          channel: "telegram",
          chatId: m.chatId,
          userId: m.userId,
          text: m.text,
          send: tg.sendMessage.bind(tg),
        })) {
          continue;
        }
        if (await handleChartIfAny({
          storageDir,
          config: loaded,
          allowlistMode: allowlistModeTelegram,
          ownerChatId: ownerTelegramChatId,
          ownerUserId: ownerTelegramUserId,
          chatId: m.chatId,
          userId: m.userId,
          text: m.text,
          isGroup: m.isGroup,
          mentionsBot: m.mentionsBot,
          replyText: m.replyText,
          sendTelegram: tg.sendPhoto.bind(tg),
          sendTelegramText: tg.sendMessage.bind(tg),
        })) {
          continue;
        }
        await handleMessage({
          storageDir,
          channel: "telegram",
          ownerChatId: ownerTelegramChatId,
          ownerUserId: ownerTelegramUserId,
          allowlistMode: allowlistModeTelegram,
          config: loaded,
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
