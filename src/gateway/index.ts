import fs from "node:fs";

import { loadConfig } from "../config/loadConfig.js";
import type { LLMProvider } from "../providers/base.js";
import { DeepSeekProvider } from "../providers/deepseek.js";
import { OpenAIProvider } from "../providers/openai.js";
import { startInternalApi } from "../internal_api.js";

type GatewayOnlyConfig = {
  gateway?: {
    storage?: { dir?: string };
    server?: { host?: string; port?: number | string };
    providers?: {
      default?: "deepseek" | "openai";
      deepseek?: {
        base_url?: string;
        model?: string;
        max_tokens?: number | string;
        temperature?: number | string;
      };
      openai?: {
        base_url?: string;
        model?: string;
        max_tokens?: number | string;
        temperature?: number | string;
      };
    };
  };
};

process.on("uncaughtException", (e: any) => console.error("[uncaughtException]", e?.stack || e));
process.on("unhandledRejection", (e: any) => console.error("[unhandledRejection]", e));

function toNumber(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildProvider(cfg: GatewayOnlyConfig): LLMProvider {
  const providers = cfg.gateway?.providers ?? {};
  const name = String(providers.default || "deepseek").trim();

  if (name === "deepseek") {
    const dcfg = providers.deepseek ?? {};
    return new DeepSeekProvider(
      String(process.env.DEEPSEEK_API_KEY || ""),
      String(dcfg.base_url || "https://api.deepseek.com"),
      String(dcfg.model || "deepseek-chat"),
      toNumber(dcfg.max_tokens, 800),
      toNumber(dcfg.temperature, 0.2),
    );
  }

  if (name === "openai") {
    return new OpenAIProvider();
  }

  throw new Error(`Unknown provider: ${name}`);
}

function main() {
  const cfg = loadConfig("config.yaml") as GatewayOnlyConfig;
  const storageDir = String(cfg.gateway?.storage?.dir || "./data");
  fs.mkdirSync(storageDir, { recursive: true });

  const provider = buildProvider(cfg);
  const serverCfg = cfg.gateway?.server ?? {};
  const host = String(process.env.CHAT_GATEWAY_HOST || serverCfg.host || "127.0.0.1");
  const port = toNumber(process.env.CHAT_GATEWAY_PORT ?? serverCfg.port, 8787);
  const token = String(process.env.CHAT_GATEWAY_TOKEN || "");

  startInternalApi({
    host,
    port,
    token,
    storageDir,
    provider,
  });

  console.log("[chat-gateway] started (gateway-only)", { provider: provider.name, host, port });
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
