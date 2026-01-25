#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import YAML from "yaml";

function parseIntEnv(name, fallback) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function parseArgs(argv) {
  const out = {
    ledgerDir: "./data",
    rawDays: parseIntEnv("RAW_TEXT_RETENTION_DAYS", 30),
    auditDays: parseIntEnv("AUDIT_RETENTION_DAYS", 90),
    redactionPolicy: "config/redaction_policy.yaml",
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--ledger-dir" && next) {
      out.ledgerDir = next;
      i += 1;
    } else if (arg === "--raw-days" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) out.rawDays = parsed;
      i += 1;
    } else if (arg === "--audit-days" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) out.auditDays = parsed;
      i += 1;
    } else if (arg === "--redaction-policy" && next) {
      out.redactionPolicy = next;
      i += 1;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
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

function loadRedactionPolicy(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    const data = YAML.parse(text);
    if (!data || typeof data !== "object") {
      return { version: "missing", hashAlgo: "sha256", fields: [], keepHeadChars: 0 };
    }
    const version = String(data.version || "").trim() || "missing";
    const hashAlgo = String(data.hash_algo || "sha256").trim() || "sha256";
    const fields = Array.isArray(data.fields) ? data.fields.map(String).filter(Boolean) : [];
    const keepHeadChars = Math.max(0, Number(data.keep_head_chars || 0) || 0);
    return { version, hashAlgo, fields, keepHeadChars };
  } catch {
    return { version: "missing", hashAlgo: "sha256", fields: [], keepHeadChars: 0 };
  }
}

function hashText(value, algo) {
  try {
    return crypto.createHash(algo).update(value).digest("hex");
  } catch {
    return crypto.createHash("sha256").update(value).digest("hex");
  }
}

function applyRawRetention(entry, fields, algo, keepHeadChars) {
  let applied = false;
  for (const field of fields) {
    const val = entry[field];
    if (typeof val !== "string" || !val) continue;
    if (!entry[`${field}_sha256`]) {
      entry[`${field}_sha256`] = hashText(val, algo);
    }
    if (keepHeadChars > 0) {
      entry[field] = val.slice(0, keepHeadChars);
    } else {
      entry[field] = "";
    }
    applied = true;
  }
  if (applied) entry.redaction_applied = true;
  return applied;
}

async function processLedgerFile(filePath, opts, cutoffs, policy) {
  const tmpPath = `${filePath}.tmp`;
  const input = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const output = fs.createWriteStream(tmpPath, { encoding: "utf-8" });
  let total = 0;
  let kept = 0;
  let dropped = 0;
  let redacted = 0;

  for await (const line of rl) {
    total += 1;
    const raw = String(line || "").trim();
    if (!raw) continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      output.write(line + "\n");
      kept += 1;
      continue;
    }
    let ts = parseTs(entry.ts_utc);
    let forceRedact = false;
    if (!ts) {
      entry.ts_utc = new Date().toISOString();
      entry.ts_utc_inferred = true;
      ts = parseTs(entry.ts_utc);
      forceRedact = true;
    }
    if (ts && ts.getTime() < cutoffs.audit) {
      dropped += 1;
      continue;
    }
    if ((forceRedact || (ts && ts.getTime() < cutoffs.raw)) && policy.fields.length) {
      if (applyRawRetention(entry, policy.fields, policy.hashAlgo, policy.keepHeadChars)) {
        redacted += 1;
      }
    }
    output.write(JSON.stringify(entry) + "\n");
    kept += 1;
  }

  await new Promise(resolve => output.end(resolve));
  if (opts.dryRun) {
    fs.unlinkSync(tmpPath);
  } else {
    fs.renameSync(tmpPath, filePath);
  }

  return { total, kept, dropped, redacted };
}

async function main() {
  const opts = parseArgs(process.argv);
  const ledgerDir = path.resolve(opts.ledgerDir);
  if (!fs.existsSync(ledgerDir)) {
    console.log(`[cleanup] ledger dir missing: ${ledgerDir}`);
    return;
  }

  const policy = loadRedactionPolicy(path.resolve(opts.redactionPolicy));
  const now = Date.now();
  const rawCutoff = now - Math.max(0, opts.rawDays) * 86400 * 1000;
  const auditCutoff = now - Math.max(0, opts.auditDays) * 86400 * 1000;

  const files = fs.readdirSync(ledgerDir).filter(name => /^ledger_\\d{4}-\\d{2}\\.jsonl$/.test(name));
  if (!files.length) {
    console.log("[cleanup] no ledger files found");
    return;
  }

  let grandTotal = 0;
  let grandKept = 0;
  let grandDropped = 0;
  let grandRedacted = 0;
  for (const name of files) {
    const filePath = path.join(ledgerDir, name);
    const stats = await processLedgerFile(filePath, opts, { raw: rawCutoff, audit: auditCutoff }, policy);
    grandTotal += stats.total;
    grandKept += stats.kept;
    grandDropped += stats.dropped;
    grandRedacted += stats.redacted;
  }

  console.log(
    "[cleanup] done "
      + `total=${grandTotal} kept=${grandKept} dropped=${grandDropped} redacted=${grandRedacted} `
      + `raw_days=${opts.rawDays} audit_days=${opts.auditDays} policy=${policy.version}`,
  );
}

await main();
