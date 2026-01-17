function toNumber(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function ensureInternalApiUrl(cfg: any) {
  if (process.env.CHAT_GATEWAY_INTERNAL_URL) return;

  const host = String(process.env.CHAT_GATEWAY_HOST || cfg.gateway?.server?.host || "127.0.0.1");
  const port = toNumber(process.env.CHAT_GATEWAY_PORT ?? cfg.gateway?.server?.port, 8787);
  process.env.CHAT_GATEWAY_INTERNAL_URL = `http://${host}:${port}`;
}
