#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

function parseArgs(argv) {
  const out = {
    ledgerDir: "./data",
    days: 7,
    sampleRate: 0.05,
    sampleLimit: 20,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--ledger-dir" && next) {
      out.ledgerDir = next;
      i += 1;
    } else if (arg === "--days" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) out.days = parsed;
      i += 1;
    } else if (arg === "--sample-rate" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) out.sampleRate = parsed;
      i += 1;
    } else if (arg === "--sample-limit" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed >= 0) out.sampleLimit = Math.floor(parsed);
      i += 1;
    }
  }
  return out;
}

function parseTs(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function listLedgerFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs.readdirSync(dirPath).filter(name => /^ledger_\d{4}-\d{2}\.jsonl$/.test(name));
  files.sort();
  return files.map(name => path.join(dirPath, name));
}

async function main() {
  const opts = parseArgs(process.argv);
  const ledgerDir = path.resolve(opts.ledgerDir);
  const files = listLedgerFiles(ledgerDir);
  if (!files.length) {
    console.log(`[trace-id-shadow] no ledger files found: ${ledgerDir}`);
    return;
  }

  const cutoff = Date.now() - opts.days * 86400 * 1000;
  let total = 0;
  let missingReason = 0;
  let traceMissing = 0;
  let missingReasonOnly = 0;
  const samples = [];

  for (const filePath of files) {
    const input = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      const raw = String(line || "").trim();
      if (!raw) continue;
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      const ts = parseTs(entry.ts_utc);
      if (ts && ts.getTime() < cutoff) continue;
      total += 1;
      const reason = String(entry.reason || "").trim();
      const errorCode = String(entry.error_code || "").trim();
      const hasMissingReason = reason === "missing_message_id_and_parent_id";
      const hasTraceMissing = errorCode === "trace_id_missing";
      if (hasMissingReason) missingReason += 1;
      if (hasTraceMissing) traceMissing += 1;
      if (hasMissingReason && !hasTraceMissing) {
        missingReasonOnly += 1;
        if (samples.length < opts.sampleLimit && Math.random() <= opts.sampleRate) {
          samples.push({
            ts_utc: entry.ts_utc,
            cmd: entry.cmd || entry.kind,
            channel: entry.channel,
            chat_id: entry.chat_id,
            reason,
            error_code: errorCode || null,
            request_id: entry.request_id,
            request_id_base: entry.request_id_base,
          });
        }
      }
    }
  }

  const mappedTotal = traceMissing + missingReasonOnly;
  const ratio = total ? (mappedTotal / total) : 0;
  const delta = mappedTotal - traceMissing;

  console.log(`[trace-id-shadow] window_days=${opts.days} total=${total}`);
  console.log(`[trace-id-shadow] trace_id_missing=${traceMissing} missing_reason=${missingReason}`);
  console.log(`[trace-id-shadow] mapped_total=${mappedTotal} delta=${delta} ratio=${ratio.toFixed(4)}`);
  if (samples.length) {
    console.log("[trace-id-shadow] samples (missing_reason without error_code):");
    for (const s of samples) {
      console.log(`- ${s.ts_utc || "?"} ${s.cmd || "?"} chat=${s.chat_id || "?"} request=${s.request_id || "?"}`);
    }
  }
}

await main();
