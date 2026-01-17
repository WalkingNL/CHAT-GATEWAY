import { TelegramPolling } from "../channels/telegramPolling.js";
import type { IntegrationContext } from "./context.js";
import { dispatchMessageEvent } from "./dispatch.js";
import { fromTelegram } from "./message_event.js";

type TelegramOpts = {
  telegram?: TelegramPolling;
  feishuSendText?: (chatId: string, text: string) => Promise<void>;
  feishuSendImage?: (chatId: string, imagePath: string) => Promise<void>;
  feishuChatId?: string;
};

export async function startTelegramPolling(ctx: IntegrationContext, opts?: TelegramOpts) {
  const { cfg } = ctx;
  const tcfg = cfg.channels?.telegram ?? {};
  const telegramEnabled = tcfg.enabled !== false;
  if (!telegramEnabled) {
    console.log("[telegram] disabled");
    return;
  }

  const ownerTelegramChatId = String(cfg.gateway?.owner?.telegram_chat_id ?? "");
  if (!ownerTelegramChatId || ownerTelegramChatId === "YOUR_OWNER_CHAT_ID") {
    throw new Error("Set gateway.owner.telegram_chat_id in config.yaml");
  }

  const tg = opts?.telegram ?? new TelegramPolling({
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
        await dispatchMessageEvent(ctx, fromTelegram(m), {
          sendText: tg.sendMessage.bind(tg),
          sendPhoto: tg.sendPhoto.bind(tg),
          sendFeishuText: opts?.feishuSendText,
          sendFeishuImage: opts?.feishuSendImage,
          feishuChatId: opts?.feishuChatId,
        });
      } catch (e: any) {
        console.error("[tg][WARN] handleMessage failed:", String(e?.message || e));
      }
    }
    await new Promise(r => setTimeout(r, Number(tcfg.poll_interval_ms || 1500)));
  }
}
