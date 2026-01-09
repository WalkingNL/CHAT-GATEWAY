import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type ExplainTrace = {
  ts_utc: string;
  channel: string;
  chat_id: string;
  user_id: string;
  project_id?: string | null;
  alert_features: {
    symbol?: string | null;
    priority?: string | null;
    factor_bucket?: string | null;
    change_pct_bucket?: string | null;
  };
  facts_summary: {
    top3_1h?: any;
    top3_24h?: any;
    symbol_recent_count?: number;
  };
  router: {
    selected_paths: string[];
  };
  llm: {
    provider?: string;
    model?: string;
    latency_ms?: number;
    ok?: boolean;
    err_code?: string;
  };
  output_meta: {
    chars?: number;
    truncated?: boolean;
  };
  feedback?: "up" | "down";
  trace_id?: string;
};

function hashId(s: string): string {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}

function dailyFile(storageDir: string, ts: string): string {
  const date = ts.slice(0, 10);
  return path.join(storageDir, `explain_traces_${date}.jsonl`);
}

export function writeExplainTrace(storageDir: string, trace: ExplainTrace): void {
  try {
    const ts = trace.ts_utc || new Date().toISOString();
    const out = {
      ...trace,
      ts_utc: ts,
      chat_id: hashId(trace.chat_id),
      user_id: hashId(trace.user_id),
    };
    const file = dailyFile(storageDir, ts);
    fs.appendFileSync(file, JSON.stringify(out) + "\n", "utf-8");
  } catch {
    // swallow errors to avoid impacting gateway
  }
}

export function writeExplainFeedback(storageDir: string, opts: {
  ts_utc: string;
  trace_id: string;
  chat_id: string;
  user_id: string;
  feedback: "up" | "down";
}) {
  try {
    const line = {
      ts_utc: opts.ts_utc,
      type: "feedback",
      trace_id: opts.trace_id,
      chat_id: hashId(opts.chat_id),
      user_id: hashId(opts.user_id),
      feedback: opts.feedback,
    };
    const file = dailyFile(storageDir, opts.ts_utc);
    fs.appendFileSync(file, JSON.stringify(line) + "\n", "utf-8");
  } catch {
    // swallow errors
  }
}
