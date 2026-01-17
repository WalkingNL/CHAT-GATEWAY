import fs from "node:fs";

import { loadConfig } from "../core/config/loadConfig.js";
import { startInternalApi } from "../core/internal_api.js";
import { buildProvider } from "../core/provider_factory.js";

process.on("uncaughtException", (e: any) => console.error("[uncaughtException]", e?.stack || e));
process.on("unhandledRejection", (e: any) => console.error("[unhandledRejection]", e));

function toNumber(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function main() {
  const cfg = loadConfig("config.yaml");
  const storageDir = String(cfg.gateway?.storage?.dir || "./data");
  fs.mkdirSync(storageDir, { recursive: true });

  const provider = buildProvider(cfg);
  const host = String(process.env.CHAT_GATEWAY_HOST || cfg.gateway?.server?.host || "127.0.0.1");
  const port = toNumber(process.env.CHAT_GATEWAY_PORT ?? cfg.gateway?.server?.port, 8787);
  const token = String(process.env.CHAT_GATEWAY_TOKEN || "");

  startInternalApi({
    host,
    port,
    token,
    storageDir,
    provider,
  });

  console.log("[chat-gateway] started (core)", { provider: provider.name, host, port });
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
