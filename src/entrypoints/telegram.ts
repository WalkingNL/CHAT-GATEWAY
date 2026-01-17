import { buildIntegrationContext } from "../integrations/runtime/context.js";
import { ensureInternalApiUrl } from "../integrations/runtime/internal_url.js";
import { startTelegramPolling } from "../integrations/runtime/telegram.js";

process.on("uncaughtException", (e: any) => console.error("[uncaughtException]", e?.stack || e));
process.on("unhandledRejection", (e: any) => console.error("[unhandledRejection]", e));

async function main() {
  const ctx = buildIntegrationContext();
  ensureInternalApiUrl(ctx.cfg);
  await startTelegramPolling(ctx);
}

function dumpUnknown(e: any) {
  try {
    if (e instanceof Error) return e.stack || e.message;
    return JSON.stringify(e, Object.getOwnPropertyNames(e));
  } catch {
    return String(e);
  }
}

main().catch((e: any) => {
  console.error("[FATAL]", dumpUnknown(e));
  process.exit(1);
});
