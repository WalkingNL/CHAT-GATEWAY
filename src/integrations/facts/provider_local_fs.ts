import fs from "node:fs";
import path from "node:path";

import type { ProjectManifest } from "../../core/config/types.js";

export type ExplainFacts = {
  window_1h: any;
  window_24h: any;
  symbol_recent: any;
  errors?: string[];
  warnings?: string[];
};

type AlertRow = {
  ts_utc?: string;
  symbol?: string;
  priority?: string;
  details?: any;
};

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function parseJsonlLines(lines: string[], errors: string[]): AlertRow[] {
  const out: AlertRow[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      out.push(obj);
    } catch {
      errors.push("jsonl_parse_failed");
    }
  }
  return out;
}

function toMs(ts: any): number | null {
  if (!ts) return null;
  if (typeof ts === "number") return ts;
  const d = new Date(String(ts));
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function within(ms: number, start: number, end: number): boolean {
  return ms >= start && ms <= end;
}

function parseDateFromFileNameMs(name: string): number | null {
  const m = name.match(/(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T23:59:59.999Z`);
  return Number.isFinite(ms) ? ms : null;
}

type FileRecord = {
  fullPath: string;
  sortMs: number;
};

function listCandidateFiles(baseDir: string, glob: string, freshnessDays: number, anchorMs: number): FileRecord[] {
  const names = fs.readdirSync(baseDir);
  const prefix = glob.split("*")[0];
  const suffix = glob.split("*").slice(1).join("*");
  const minMs = anchorMs - freshnessDays * 24 * 60 * 60 * 1000;
  const out: FileRecord[] = [];

  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith(suffix)) continue;
    const fullPath = path.join(baseDir, n);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(fullPath).mtimeMs || 0;
    } catch {
      mtimeMs = 0;
    }
    const dateMs = parseDateFromFileNameMs(n);
    const sortMs = dateMs ?? mtimeMs;
    if (sortMs < minMs) continue;
    out.push({ fullPath, sortMs });
  }

  out.sort((a, b) => b.sortMs - a.sortMs);
  return out;
}

function buildTopN(rows: AlertRow[], start: number, end: number) {
  let total = 0;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const ms = toMs(r.ts_utc || (r as any).ts || (r as any).ts_iso);
    if (!ms) continue;
    if (!within(ms, start, end)) continue;
    const sym = String((r as any).symbol || "").trim();
    if (!sym) continue;
    total += 1;
    counts.set(sym, (counts.get(sym) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top3 = sorted.slice(0, 3).map(([symbol, count]) => ({ symbol, count }));
  return { total, symbol_count: counts.size, top3, counts };
}

function buildSymbolRecent(rows: AlertRow[], symbol: string, start: number, end: number, limit: number) {
  const items: any[] = [];
  for (const r of rows) {
    const ms = toMs(r.ts_utc || (r as any).ts || (r as any).ts_iso);
    if (!ms) continue;
    if (!within(ms, start, end)) continue;
    const sym = String((r as any).symbol || "").trim();
    if (sym !== symbol) continue;

    const pr = String((r as any).priority || "");
    const det = (r as any).details || {};
    const factor = det?.factor ?? det?.volume_factor ?? undefined;

    items.push({
      ts_utc: new Date(ms).toISOString(),
      priority: pr,
      factor: typeof factor === "number" ? factor : (factor ? Number(factor) : undefined),
    });
  }
  items.sort((a, b) => (a.ts_utc < b.ts_utc ? 1 : -1));
  return items.slice(0, limit);
}

export class LocalFsFactsProvider {
  constructor(
    private projects: Record<string, ProjectManifest>,
  ) {}

  buildExplainFacts(params: {
    project_id: string;
    anchor_ts_utc: string;
    symbol?: string;
    recent_n?: number;
  }): ExplainFacts {
    const errors: string[] = [];

    const proj = this.projects[params.project_id];
    if (!proj || !proj.enabled) {
      return {
        window_1h: { ok: false, reason: "project_not_found" },
        window_24h: { ok: false, reason: "project_not_found" },
        symbol_recent: { ok: false, reason: "project_not_found" },
        errors: ["project_not_found"],
      };
    }
    if (proj.kind !== "local_fs" || !proj.root) {
      return {
        window_1h: { ok: false, reason: "unsupported_kind" },
        window_24h: { ok: false, reason: "unsupported_kind" },
        symbol_recent: { ok: false, reason: "unsupported_kind" },
        errors: ["unsupported_kind"],
      };
    }

    const res = proj.resources?.alerts_sent_jsonl as any;
    if (!res || res.type !== "file_glob") {
      return {
        window_1h: { ok: false, reason: "resource_missing" },
        window_24h: { ok: false, reason: "resource_missing" },
        symbol_recent: { ok: false, reason: "resource_missing" },
        errors: ["resource_missing"],
      };
    }

    const base = String(res.base || "").trim();
    const glob = String(res.glob || "").trim();
    const maxLines = clamp(Number(res.max_lines || 400), 50, 2000);
    const maxBytes = clamp(Number(res.max_bytes || 400000), 50000, 2000000);
    const anchorMs = new Date(params.anchor_ts_utc).getTime();
    if (!Number.isFinite(anchorMs)) {
      return {
        window_1h: { ok: false, reason: "bad_anchor_ts" },
        window_24h: { ok: false, reason: "bad_anchor_ts" },
        symbol_recent: { ok: false, reason: "bad_anchor_ts" },
        errors: ["bad_anchor_ts"],
      };
    }

    const baseDir = path.join(proj.root, base);
    let files: FileRecord[] = [];
    try {
      const freshnessDays = clamp(Number(res.freshness_days || 14), 1, 90);
      files = listCandidateFiles(baseDir, glob, freshnessDays, anchorMs);
    } catch {
      return {
        window_1h: { ok: false, reason: "dir_read_failed" },
        window_24h: { ok: false, reason: "dir_read_failed" },
        symbol_recent: { ok: false, reason: "dir_read_failed" },
        errors: ["dir_read_failed"],
      };
    }
    if (!files.length) {
      return {
        window_1h: { ok: false, reason: "file_not_found" },
        window_24h: { ok: false, reason: "file_not_found" },
        symbol_recent: { ok: false, reason: "file_not_found" },
        errors: ["file_not_found"],
      };
    }

    const w1h = { start: anchorMs - 60 * 60 * 1000, end: anchorMs };
    const w24h = { start: anchorMs - 24 * 60 * 60 * 1000, end: anchorMs };

    const allLines: string[] = [];
    let totalBytes = 0;
    for (const file of files) {
      try {
        const content = fs.readFileSync(file.fullPath, "utf-8");
        const bytes = Buffer.byteLength(content, "utf-8");
        if (totalBytes + bytes > maxBytes) {
          errors.push("limit_exceeded");
          break;
        }
        totalBytes += bytes;
        const lines = content.split("\n");
        const tail = lines.slice(Math.max(0, lines.length - maxLines));
        allLines.push(...tail);
      } catch {
        errors.push("file_read_failed");
      }
    }

    const rows = parseJsonlLines(allLines, errors);

    const top1h = buildTopN(rows, w1h.start, w1h.end);
    const top24h = buildTopN(rows, w24h.start, w24h.end);

    const symbol = params.symbol;
    const recentN = clamp(params.recent_n ?? 5, 1, 20);

    const symbolRecent = symbol
      ? buildSymbolRecent(rows, symbol, w24h.start, w24h.end, recentN)
      : [];

    const rank1h = symbol ? (() => {
      const sorted = [...top1h.counts.entries()].sort((a, b) => b[1] - a[1]);
      const idx = sorted.findIndex(([s]) => s === symbol);
      return idx >= 0 ? idx + 1 : null;
    })() : null;

    const rank24h = symbol ? (() => {
      const sorted = [...top24h.counts.entries()].sort((a, b) => b[1] - a[1]);
      const idx = sorted.findIndex(([s]) => s === symbol);
      return idx >= 0 ? idx + 1 : null;
    })() : null;

    const uniqErrors = [...new Set(errors)];
    const hardErrors = uniqErrors.filter((e) => e !== "limit_exceeded").slice(0, 5);
    const warnings = uniqErrors.includes("limit_exceeded") ? ["history_truncated"] : [];
    const failedReason = rows.length === 0 && hardErrors.includes("file_read_failed")
      ? "file_read_failed"
      : null;

    return {
      window_1h: {
        ok: failedReason ? false : true,
        ...(failedReason ? { reason: failedReason } : {}),
        total: top1h.total,
        symbol_count: top1h.symbol_count,
        top3: top1h.top3,
        symbol_rank: rank1h,
      },
      window_24h: {
        ok: failedReason ? false : true,
        ...(failedReason ? { reason: failedReason } : {}),
        total: top24h.total,
        symbol_count: top24h.symbol_count,
        top3: top24h.top3,
        symbol_rank: rank24h,
      },
      symbol_recent: {
        ok: failedReason ? false : !!symbol,
        reason: failedReason || (symbol ? undefined : "symbol_missing"),
        items: symbolRecent,
      },
      ...(hardErrors.length ? { errors: hardErrors } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }
}
