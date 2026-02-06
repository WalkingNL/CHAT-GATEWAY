import fs from "node:fs";
import path from "node:path";

type LastAlertEntry = { ts: number; rawText: string };
type LastExplainEntry = { ts: number; trace_id: string };

function parseIntEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const val = Number(raw);
  if (!Number.isFinite(val)) return fallback;
  return Math.max(0, Math.floor(val));
}

const LAST_ALERT_TTL_MS = parseIntEnv("CHAT_GATEWAY_LAST_ALERT_TTL_MS", 24 * 60 * 60 * 1000);
const LAST_ALERT_MAX_ITEMS = parseIntEnv("CHAT_GATEWAY_LAST_ALERT_MAX_ITEMS", 500);
const LAST_ALERT_MAX_CHARS = parseIntEnv("CHAT_GATEWAY_LAST_ALERT_MAX_CHARS", 8000);
const LAST_ALERT_PERSIST = String(process.env.CHAT_GATEWAY_LAST_ALERT_PERSIST || "") === "1";

const LAST_EXPLAIN_TTL_MS = parseIntEnv("CHAT_GATEWAY_LAST_EXPLAIN_TTL_MS", 6 * 60 * 60 * 1000);
const LAST_EXPLAIN_MAX_ITEMS = parseIntEnv("CHAT_GATEWAY_LAST_EXPLAIN_MAX_ITEMS", 500);

const lastAlerts = new Map<string, LastAlertEntry>();
let lastAlertsLoadedDir: string | null = null;

const lastExplains = new Map<string, LastExplainEntry>();

function clipText(s: string, n: number): string {
  const t = String(s || "");
  if (t.length <= n) return t;
  if (n <= 3) return t.slice(0, n);
  return t.slice(0, n - 3) + "...";
}

function pruneMap<T extends { ts: number }>(map: Map<string, T>, now: number, ttlMs: number, maxItems: number) {
  for (const [key, entry] of map) {
    if (ttlMs > 0 && now - entry.ts > ttlMs) {
      map.delete(key);
    }
  }
  if (map.size <= maxItems) return;
  const entries = Array.from(map.entries());
  entries.sort((a, b) => a[1].ts - b[1].ts);
  const removeCount = Math.max(0, entries.length - maxItems);
  for (let i = 0; i < removeCount; i += 1) {
    map.delete(entries[i][0]);
  }
}

function lastAlertPath(storageDir: string) {
  return path.join(storageDir, "state_last_alerts.json");
}

function loadLastAlerts(storageDir: string) {
  if (lastAlertsLoadedDir === storageDir) return;
  lastAlertsLoadedDir = storageDir;
  lastAlerts.clear();
  const p = lastAlertPath(storageDir);
  if (!fs.existsSync(p)) return;
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(raw);
    const items = data && typeof data === "object" ? (data.items as Record<string, any>) : null;
    if (!items || typeof items !== "object") return;
    const now = Date.now();
    for (const [chatId, entry] of Object.entries(items)) {
      const ts = Number((entry as any)?.ts || 0);
      const rawText = clipText(String((entry as any)?.rawText || ""), LAST_ALERT_MAX_CHARS);
      if (!ts || !rawText) continue;
      if (LAST_ALERT_TTL_MS > 0 && now - ts > LAST_ALERT_TTL_MS) continue;
      lastAlerts.set(String(chatId), { ts, rawText });
    }
    pruneMap(lastAlerts, now, LAST_ALERT_TTL_MS, LAST_ALERT_MAX_ITEMS);
  } catch {
    // ignore corrupted cache
  }
}

function persistLastAlerts(storageDir: string) {
  if (!LAST_ALERT_PERSIST) return;
  fs.mkdirSync(storageDir, { recursive: true });
  const items: Record<string, LastAlertEntry> = {};
  for (const [chatId, entry] of lastAlerts) {
    items[chatId] = entry;
  }
  const payload = {
    version: 1,
    updated_at_utc: new Date().toISOString(),
    items,
  };
  fs.writeFileSync(lastAlertPath(storageDir), JSON.stringify(payload, null, 2), "utf-8");
}

export function getLastAlert(storageDir: string, chatId: string): string {
  if (!storageDir) return "";
  loadLastAlerts(storageDir);
  const entry = lastAlerts.get(chatId);
  if (!entry) return "";
  if (LAST_ALERT_TTL_MS > 0 && Date.now() - entry.ts > LAST_ALERT_TTL_MS) {
    lastAlerts.delete(chatId);
    return "";
  }
  return entry.rawText || "";
}

export function setLastAlert(storageDir: string, chatId: string, rawText: string) {
  if (!storageDir) return;
  loadLastAlerts(storageDir);
  const now = Date.now();
  const clipped = clipText(rawText, LAST_ALERT_MAX_CHARS);
  lastAlerts.set(chatId, { ts: now, rawText: clipped });
  pruneMap(lastAlerts, now, LAST_ALERT_TTL_MS, LAST_ALERT_MAX_ITEMS);
  persistLastAlerts(storageDir);
}

export function getLastExplainTrace(chatId: string): LastExplainEntry | null {
  const entry = lastExplains.get(chatId);
  if (!entry) return null;
  if (LAST_EXPLAIN_TTL_MS > 0 && Date.now() - entry.ts > LAST_EXPLAIN_TTL_MS) {
    lastExplains.delete(chatId);
    return null;
  }
  return entry;
}

export function setLastExplainTrace(chatId: string, traceId: string) {
  const now = Date.now();
  lastExplains.set(chatId, { ts: now, trace_id: traceId });
  pruneMap(lastExplains, now, LAST_EXPLAIN_TTL_MS, LAST_EXPLAIN_MAX_ITEMS);
}
