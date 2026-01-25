import fs from "node:fs";
import path from "node:path";
import { getAuditMeta, applyRedaction } from "../runtime/audit_policy.js";
import { getCapabilityAuditMeta } from "../runtime/capabilities.js";

export function ledgerPath(storageDir: string) {
  const d = new Date();
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return path.join(storageDir, `ledger_${ym}.jsonl`);
}

export function appendLedger(storageDir: string, obj: any) {
  const meta = {
    ...getCapabilityAuditMeta(),
    ...getAuditMeta(),
  };
  const merged = { ...obj, ...meta };
  const redacted = applyRedaction(merged);
  redacted.entry.redaction_applied = redacted.applied;

  fs.mkdirSync(storageDir, { recursive: true });
  fs.appendFileSync(ledgerPath(storageDir), JSON.stringify(redacted.entry) + "\n", "utf-8");
}
