import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type CognitiveStatus = "OPEN" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "DISMISSED";

export type CognitiveType = "question" | "idea" | "observation" | "task" | "alert_followup";

export type CognitiveSource = {
  channel: "telegram" | "feishu" | "legacy";
  chat_type: "private" | "group" | "system";
  chat_id: string;
  user_id: string;
  message_id?: string;
  reply_to_id?: string;
  mentions_bot?: boolean;
};

export type CognitiveItem = {
  issue_id: string;
  short_id: string;
  type: CognitiveType;
  raw_text: string;
  normalized_text: string;
  dedup_key: string;
  source: CognitiveSource;
  status: CognitiveStatus;
  created_at_utc: string;
  next_remind_at_utc?: string | null;
  reminded_at_utc?: string | null;
  updated_at_utc?: string | null;
};

export type CognitivePending = {
  key: string;
  issue_id: string;
  created_at_utc: string;
  expires_at_utc: string;
  raw_text: string;
  normalized_text: string;
  dedup_key: string;
  type: CognitiveType;
  source: CognitiveSource;
  next_remind_at_utc?: string | null;
};

type CognitiveStateFile = {
  items: Record<string, CognitiveItem>;
  short_id_index: Record<string, string>;
  last_seq_by_day: Record<string, number>;
  pending: Record<string, CognitivePending>;
};

type CognitiveEvent = {
  ts_utc: string;
  event: "created" | "status_updated" | "reminded" | "migrated";
  issue_id: string;
  short_id?: string;
  status?: CognitiveStatus;
  updated_by?: string;
  item?: CognitiveItem;
  note?: string;
};

function emptyState(): CognitiveStateFile {
  return {
    items: {},
    short_id_index: {},
    last_seq_by_day: {},
    pending: {},
  };
}

function utcNow(): string {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(filePath: string, data: any) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

export function normalizeText(text: string): string {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\u3000/g, " ")
    .trim();
}

export function hashText(text: string): string {
  return createHash("sha256").update(String(text || "")).digest("hex").slice(0, 16);
}

export function buildIssueId(
  channel: string,
  chatId: string,
  messageId?: string,
  replyToId?: string,
): string | null {
  const key = messageId || replyToId;
  if (!key) return null;
  return `${channel}:${chatId}:${key}`;
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function parseShortId(shortId: string): { day: string; seq: number } | null {
  const m = /^C-(\d{8})-(\d{3})$/i.exec(String(shortId || ""));
  if (!m) return null;
  return { day: m[1], seq: Number(m[2]) };
}

export class CognitiveStore {
  private state: CognitiveStateFile | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private storageDir: string) {}

  private baseDir() {
    return path.join(this.storageDir, "cognitive");
  }

  private ledgerPath() {
    return path.join(this.baseDir(), "cognitive_ledger.jsonl");
  }

  private lockPath() {
    return path.join(this.baseDir(), "cognitive_state.lock");
  }

  private statePath() {
    return path.join(this.baseDir(), "cognitive_state.json");
  }

  private withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(() => fn());
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async acquireFileLock(): Promise<() => void> {
    ensureDir(this.baseDir());
    const lockPath = this.lockPath();
    const timeoutMs = Number(process.env.COGNITIVE_LOCK_TIMEOUT_MS || 5000);
    const staleMs = Number(process.env.COGNITIVE_LOCK_STALE_MS || 30000);
    const start = Date.now();

    while (true) {
      try {
        const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts_ms: Date.now() }), "utf-8");
        } catch {
          // ignore metadata write errors
        }
        return () => {
          try {
            fs.closeSync(fd);
          } catch {
            // ignore close errors
          }
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // ignore unlink errors
          }
        };
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          // ignore stat/unlink errors
        }
        if (Date.now() - start > timeoutMs) {
          throw new Error("cognitive_lock_timeout");
        }
        await sleep(30);
      }
    }
  }

  private withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.withLock(async () => {
      const release = await this.acquireFileLock();
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  private loadState(): CognitiveStateFile {
    ensureDir(this.baseDir());
    const p = this.statePath();
    if (!fs.existsSync(p)) {
      this.state = emptyState();
      return this.state;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      this.state = {
        items: raw.items || {},
        short_id_index: raw.short_id_index || {},
        last_seq_by_day: raw.last_seq_by_day || {},
        pending: raw.pending || {},
      };
      return this.state;
    } catch {
      this.state = emptyState();
      return this.state;
    }
  }

  private saveState(state: CognitiveStateFile) {
    ensureDir(this.baseDir());
    atomicWriteJson(this.statePath(), state);
    this.state = state;
  }

  private appendEvent(evt: CognitiveEvent) {
    ensureDir(this.baseDir());
    fs.appendFileSync(this.ledgerPath(), JSON.stringify(evt) + "\n", "utf-8");
  }

  private nextShortId(createdAt: string, state: CognitiveStateFile): string {
    const day = formatDay(createdAt);
    const seq = (state.last_seq_by_day[day] || 0) + 1;
    state.last_seq_by_day[day] = seq;
    return `C-${day}-${String(seq).padStart(3, "0")}`;
  }

  private bumpSeqFromShortId(shortId: string, state: CognitiveStateFile) {
    const parsed = parseShortId(shortId);
    if (!parsed) return;
    const prev = state.last_seq_by_day[parsed.day] || 0;
    if (parsed.seq > prev) state.last_seq_by_day[parsed.day] = parsed.seq;
  }

  private reserveShortId(
    requested: string | undefined,
    createdAt: string,
    state: CognitiveStateFile,
    issueId: string,
  ): string {
    if (requested) {
      const owner = state.short_id_index[requested];
      if (!owner || owner === issueId) {
        this.bumpSeqFromShortId(requested, state);
        return requested;
      }
    }
    let shortId = this.nextShortId(createdAt, state);
    while (state.short_id_index[shortId]) {
      shortId = this.nextShortId(createdAt, state);
    }
    return shortId;
  }

  private createItemLocked(
    item: Omit<CognitiveItem, "short_id"> & { short_id?: string },
    state: CognitiveStateFile,
  ): { item: CognitiveItem; created: boolean } {
    const existing = state.items[item.issue_id];
    if (existing) return { item: existing, created: false };
    const shortId = this.reserveShortId(item.short_id, item.created_at_utc, state, item.issue_id);
    const full: CognitiveItem = { ...item, short_id: shortId };
    state.items[item.issue_id] = full;
    state.short_id_index[shortId] = item.issue_id;
    return { item: full, created: true };
  }

  listItems(opts?: { status?: CognitiveStatus[]; limit?: number }): CognitiveItem[] {
    const state = this.loadState();
    let items = Object.values(state.items);
    if (opts?.status && opts.status.length > 0) {
      const set = new Set(opts.status);
      items = items.filter(item => set.has(item.status));
    }
    items.sort((a, b) => String(b.created_at_utc).localeCompare(String(a.created_at_utc)));
    if (opts?.limit && opts.limit > 0) {
      items = items.slice(0, opts.limit);
    }
    return items;
  }

  getItemByIdOrShortId(id: string): CognitiveItem | null {
    const state = this.loadState();
    if (state.items[id]) return state.items[id];
    const issueId = state.short_id_index[id];
    if (issueId && state.items[issueId]) return state.items[issueId];
    return null;
  }

  async createItem(item: Omit<CognitiveItem, "short_id"> & { short_id?: string }): Promise<CognitiveItem> {
    return this.withWriteLock(() => {
      const state = this.loadState();
      const created = this.createItemLocked(item, state);
      if (!created.created) return created.item;
      this.saveState(state);
      this.appendEvent({
        ts_utc: utcNow(),
        event: "created",
        issue_id: item.issue_id,
        short_id: created.item.short_id,
        item: created.item,
      });
      return created.item;
    });
  }

  async updateStatus(idOrShortId: string, status: CognitiveStatus, updatedBy?: string): Promise<CognitiveItem | null> {
    return this.withWriteLock(() => {
      const state = this.loadState();
      const issueId = state.items[idOrShortId] ? idOrShortId : state.short_id_index[idOrShortId];
      if (!issueId || !state.items[issueId]) return null;
      const item = state.items[issueId];
      item.status = status;
      item.updated_at_utc = utcNow();
      state.items[issueId] = item;
      this.saveState(state);
      this.appendEvent({
        ts_utc: utcNow(),
        event: "status_updated",
        issue_id: issueId,
        short_id: item.short_id,
        status,
        updated_by: updatedBy,
      });
      return item;
    });
  }

  async markReminded(issueId: string, note?: string): Promise<CognitiveItem | null> {
    return this.withWriteLock(() => {
      const state = this.loadState();
      const item = state.items[issueId];
      if (!item) return null;
      item.reminded_at_utc = utcNow();
      item.updated_at_utc = item.reminded_at_utc;
      state.items[issueId] = item;
      this.saveState(state);
      this.appendEvent({
        ts_utc: utcNow(),
        event: "reminded",
        issue_id: issueId,
        short_id: item.short_id,
        status: item.status,
        note,
      });
      return item;
    });
  }

  listDueReminders(nowMs: number): CognitiveItem[] {
    const state = this.loadState();
    return Object.values(state.items).filter(item => {
      if (!item.next_remind_at_utc) return false;
      if (item.reminded_at_utc) return false;
      if (item.status === "DONE" || item.status === "DISMISSED") return false;
      const t = Date.parse(item.next_remind_at_utc);
      return Number.isFinite(t) && t <= nowMs;
    });
  }

  async setPending(pending: CognitivePending | null) {
    return this.withWriteLock(() => {
      const state = this.loadState();
      if (!pending) return;
      state.pending[pending.key] = pending;
      this.saveState(state);
    });
  }

  async getPending(key: string): Promise<CognitivePending | null> {
    return this.withWriteLock(() => {
      const state = this.loadState();
      const pending = state.pending[key];
      if (!pending) return null;
      const exp = Date.parse(pending.expires_at_utc);
      if (Number.isFinite(exp) && exp < Date.now()) {
        delete state.pending[key];
        this.saveState(state);
        return null;
      }
      return pending;
    });
  }

  async clearPending(key: string) {
    return this.withWriteLock(() => {
      const state = this.loadState();
      if (state.pending[key]) {
        delete state.pending[key];
        this.saveState(state);
      }
    });
  }

  async importItems(
    items: Array<Omit<CognitiveItem, "short_id"> & { short_id?: string }>,
  ): Promise<{ inserted: number; skipped: number }> {
    return this.withWriteLock(() => {
      const state = this.loadState();
      let inserted = 0;
      let skipped = 0;
      for (const item of items) {
        if (state.items[item.issue_id]) {
          skipped += 1;
          continue;
        }
        const created = this.createItemLocked(item, state);
        if (created.created) {
          this.appendEvent({
            ts_utc: utcNow(),
            event: "migrated",
            issue_id: created.item.issue_id,
            short_id: created.item.short_id,
            item: created.item,
          });
          inserted += 1;
        } else {
          skipped += 1;
        }
      }
      this.saveState(state);
      return { inserted, skipped };
    });
  }
}
