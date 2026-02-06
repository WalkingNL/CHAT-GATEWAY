export function parseIntEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const val = Number(raw);
  if (!Number.isFinite(val)) return fallback;
  return Math.max(0, Math.floor(val));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function taskPrefix(channel: string): string {
  if (channel === "telegram") return "tg";
  if (channel === "feishu") return "fs";
  const clean = channel.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return clean ? clean.slice(0, 12) : "chan";
}

export function clip(s: string, n: number): string {
  const t = String(s || "");
  return t.length <= n ? t : t.slice(0, n) + "…";
}

export function clipToLen(s: string, n: number): string {
  const t = String(s || "");
  if (t.length <= n) return t;
  if (n <= 1) return t.slice(0, n);
  return t.slice(0, n - 1) + "…";
}
