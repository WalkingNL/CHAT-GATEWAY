import fs from "node:fs";
import { loadConfig } from "./config/loadConfig.js";
import { loadAllConfig } from "./config/index.js";
import { listPaths } from "./explain/path_registry.js";
import { registerDefaultPaths } from "./explain/paths/index.js";
import { appendLedger } from "./audit/ledger.js";
import { FeishuWebhook } from "./channels/feishuWebhook.js";
import { detectChartIntents, renderChart } from "./channels/charts.js";
import { detectFeedback, FEEDBACK_REPLY, updatePushPolicyTargets } from "./channels/feedback.js";
import { TelegramPolling } from "./channels/telegramPolling.js";
import { DeepSeekProvider } from "./providers/deepseek.js";
import { RateLimiter } from "./rateLimit/limiter.js";
import { loadAuth } from "./auth/store.js";
import { handleMessage } from "./router/router.js";
import { startInternalApi } from "./internal_api.js";
import { evaluate } from "./config/index.js";
import type { LoadedConfig } from "./config/types.js";

process.on("uncaughtException", (e: any) => console.error("[uncaughtException]", e?.stack || e));
process.on("unhandledRejection", (e: any) => console.error("[unhandledRejection]", e));

async function handleFeedbackIfAny(params: {
  storageDir: string;
  channel: string;
  chatId: string;
  userId: string;
  text: string;
  send: (chatId: string, text: string) => Promise<void>;
}): Promise<boolean> {
  const { storageDir, channel, chatId, userId, text, send } = params;
  const hit = detectFeedback(text);
  if (!hit) return false;

  let update: ReturnType<typeof updatePushPolicyTargets> | null = null;
  let error: string | null = null;
  try {
    update = updatePushPolicyTargets(hit.kind, { updatedBy: `${channel}:${userId}` });
  } catch (e: any) {
    error = String(e?.message || e);
    console.error("[feedback][WARN] update failed:", error);
  }

  await send(chatId, FEEDBACK_REPLY);
  appendLedger(storageDir, {
    ts_utc: new Date().toISOString(),
    channel,
    chat_id: chatId,
    user_id: userId,
    kind: "alert_feedback",
    feedback: hit.kind,
    raw: hit.normalizedText,
    policy_path: update?.path,
    target_prev: update?.prevTarget,
    target_next: update?.nextTarget,
    error: error || undefined,
  });

  return true;
}

async function handleChartIfAny(params: {
  storageDir: string;
  config: LoadedConfig;
  allowlistMode: "owner_only" | "auth";
  ownerChatId: string;
  ownerUserId: string;
  chatId: string;
  userId: string;
  text: string;
  isGroup: boolean;
  mentionsBot: boolean;
  replyText: string;
  sendTelegram: (chatId: string, imagePath: string, caption?: string) => Promise<void>;
  sendTelegramText: (chatId: string, text: string) => Promise<void>;
  sendFeishuImage?: (chatId: string, imagePath: string) => Promise<void>;
  sendFeishuText?: (chatId: string, text: string) => Promise<void>;
  feishuChatId?: string;
}): Promise<boolean> {
  const {
    storageDir,
    config,
    allowlistMode,
    ownerChatId,
    ownerUserId,
    chatId,
    userId,
    text,
    isGroup,
    mentionsBot,
    replyText,
    sendTelegram,
    sendTelegramText,
    sendFeishuImage,
    sendFeishuText,
    feishuChatId,
  } = params;

  const trimmed = String(text || "").trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  const commandToken = "/chart";
  let chartQuery: string | null = null;
  let usedCommand = false;

  if (lower.startsWith(commandToken)) {
    chartQuery = trimmed.slice(commandToken.length).trim();
    usedCommand = true;
  } else if (mentionsBot && lower.includes(commandToken)) {
    const idx = lower.indexOf(commandToken);
    chartQuery = trimmed.slice(idx + commandToken.length).trim();
    usedCommand = true;
  } else if (!isGroup) {
    chartQuery = trimmed;
  } else {
    return false;
  }

  if (!chartQuery) {
    if (usedCommand) {
      await sendTelegramText(chatId, "Usage: /chart <symbol> <factor|daily activity> <time window>");
      return true;
    }
    return false;
  }

  const intents = detectChartIntents(chartQuery);
  if (!intents.length) {
    if (usedCommand) {
      await sendTelegramText(chatId, "未识别图表类型。示例：/chart BTC factor timeline 24h");
      return true;
    }
    return false;
  }

  const authState = loadAuth(storageDir, ownerChatId, "telegram");
  const isOwnerChat = chatId === ownerChatId;
  const isOwnerUser = ownerUserId ? userId === ownerUserId : false;
  const allowed =
    allowlistMode === "owner_only"
      ? (isGroup ? isOwnerUser : isOwnerChat)
      : authState.allowed.includes(chatId) || isOwnerUser;
  const policyOk = config?.meta?.policyOk === true;
  const chatType = isGroup ? "group" : "private";

  const checkAllowed = (capability: string) => {
    const res = evaluate(config, {
      channel: "telegram",
      capability,
      chat_id: chatId,
      chat_type: chatType,
      user_id: userId,
      mention_bot: mentionsBot,
      has_reply: Boolean(replyText),
    });
    if (res.require?.mention_bot_for_ops && !mentionsBot) {
      return { allowed: false, silent: true, res };
    }
    const isAllowed = policyOk ? res.allowed : allowed;
    return { allowed: isAllowed, res };
  };

  for (const intent of intents) {
    const capability =
      intent.kind === "factor_timeline"
        ? "ops.chart.factor_timeline"
        : "ops.chart.daily_activity";
    const gate = checkAllowed(capability);
    if (!gate.allowed) {
      if (!gate.silent) {
        await sendTelegramText(
          chatId,
          gate.res?.deny_message || "🚫 未授权操作\n本群 Bot 仅对项目 Owner 开放解释能力。",
        );
      }
      return true;
    }

    if (intent.kind === "factor_timeline" && !intent.symbol) {
      await sendTelegramText(chatId, "请指定币种（BTC/ETH/BTCUSDT）");
      return true;
    }

    try {
      const rendered = renderChart(intent);
      await sendTelegram(chatId, rendered.outPath, rendered.caption);
      if (sendFeishuImage && sendFeishuText && feishuChatId) {
        await sendFeishuText(feishuChatId, rendered.caption);
        await sendFeishuImage(feishuChatId, rendered.outPath);
      }
    } catch (e: any) {
      await sendTelegramText(chatId, `图表生成失败：${String(e?.message || e)}`);
      return true;
    }
  }

  return true;
}

async function main() {
  const cfg = loadConfig("config.yaml");
  const loaded = loadAllConfig();
  registerDefaultPaths();
  console.log("[explain] paths", listPaths().map(p => p.id));
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

  const tcfg = cfg.channels?.telegram ?? {};
  const telegramEnabled = tcfg.enabled !== false;
  const ownerTelegramChatId = String(cfg.gateway?.owner?.telegram_chat_id ?? "");
  const ownerTelegramUserId = String(process.env.OWNER_TELEGRAM_USER_ID || "");
  if (telegramEnabled && (!ownerTelegramChatId || ownerTelegramChatId === "YOUR_OWNER_CHAT_ID")) {
    throw new Error("Set gateway.owner.telegram_chat_id in config.yaml");
  }

  const fcfg = cfg.channels?.feishu ?? {};
  const feishuEnabled = Boolean(fcfg.enabled);
  const ownerFeishuChatId = String(cfg.gateway?.owner?.feishu_chat_id ?? "");
  if (feishuEnabled && !ownerFeishuChatId) {
    throw new Error("Set gateway.owner.feishu_chat_id in config.yaml");
  }

  const allowlistModeTelegram = (tcfg.allowlist_mode ?? "auth") as "owner_only" | "auth";
  const allowlistModeFeishu = (fcfg.allowlist_mode ?? "auth") as "owner_only" | "auth";

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

  const tg = telegramEnabled
    ? new TelegramPolling({
        bot_token_env: String(tcfg.bot_token_env || "TELEGRAM_BOT_TOKEN"),
        poll_interval_ms: Number(tcfg.poll_interval_ms || 1500),
      })
    : null;

  const feishu = feishuEnabled
    ? new FeishuWebhook({
        app_id_env: String(fcfg.app_id_env || "FEISHU_APP_ID"),
        app_secret_env: String(fcfg.app_secret_env || "FEISHU_APP_SECRET"),
        verification_token_env: String(fcfg.verification_token_env || "FEISHU_VERIFICATION_TOKEN"),
        bot_user_id_env: String(fcfg.bot_user_id_env || "FEISHU_BOT_USER_ID"),
        bot_open_id_env: String(fcfg.bot_open_id_env || "FEISHU_BOT_OPEN_ID"),
        bot_name_env: String(fcfg.bot_name_env || "FEISHU_BOT_NAME"),
        base_url: String(fcfg.base_url || "https://open.feishu.cn/open-apis"),
      })
    : null;

  console.log("[chat-gateway] started");

  const host = String(process.env.CHAT_GATEWAY_HOST || "127.0.0.1");
  const port = Number(process.env.CHAT_GATEWAY_PORT || 8787);
  const token = String(process.env.CHAT_GATEWAY_TOKEN || "");

  const feishuEventPathRaw = String(fcfg.event_path || "/feishu/events");
  const feishuEventPath = feishuEventPathRaw.startsWith("/") ? feishuEventPathRaw : `/${feishuEventPathRaw}`;

  startInternalApi({
    host,
    port,
    token,
    storageDir,
    provider,
    feishu: feishu
      ? {
          path: feishuEventPath,
          handler: async (body) => {
            const res = await feishu.handleEvent(body);
            if (res.kind === "challenge") {
              return { body: { challenge: res.challenge } };
            }
            if (res.kind === "message") {
              const m = res.msg;
              if (await handleFeedbackIfAny({
                storageDir,
                channel: "feishu",
                chatId: m.chatId,
                userId: m.userId,
                text: m.text,
                send: feishu.sendMessage.bind(feishu),
              })) {
                return { body: { code: 0 } };
              }
              void handleMessage({
                storageDir,
                channel: "feishu",
                ownerChatId: ownerFeishuChatId,
                ownerUserId: String(process.env.OWNER_FEISHU_USER_ID || ""),
                allowlistMode: allowlistModeFeishu,
                config: loaded,
                provider,
                limiter,
                chatId: m.chatId,
                userId: m.userId,
                text: m.text,
                replyText: m.replyText,
                isGroup: m.isGroup,
                mentionsBot: m.mentionsBot,
                send: feishu.sendMessage.bind(feishu),
              }).catch((e: any) => {
                console.error("[feishu][WARN] handleMessage failed:", String(e?.message || e));
              });
            }
            return { body: { code: 0 } };
          },
        }
      : undefined,
  });

  while (telegramEnabled) {
    let msgs: any[] = [];
    try {
      msgs = await tg!.pollOnce();
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
          send: tg!.sendMessage.bind(tg),
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
          sendTelegram: tg!.sendPhoto.bind(tg),
          sendTelegramText: tg!.sendMessage.bind(tg),
          sendFeishuImage: feishu?.sendImage.bind(feishu),
          sendFeishuText: feishu?.sendMessage.bind(feishu),
          feishuChatId: ownerFeishuChatId,
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
          provider,
          limiter,
          chatId: m.chatId,
          userId: m.userId,
          text: m.text,
          replyText: m.replyText,
          isGroup: m.isGroup,
          mentionsBot: m.mentionsBot,
          send: tg!.sendMessage.bind(tg),
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
