import fs from "node:fs";
import path from "node:path";

export function ledgerPath(storageDir: string) {
  const d = new Date();
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return path.join(storageDir, `ledger_${ym}.jsonl`);
}

export function appendLedger(storageDir: string, obj: any) {
  fs.mkdirSync(storageDir, { recursive: true });
  fs.appendFileSync(ledgerPath(storageDir), JSON.stringify(obj) + "\n", "utf-8");
}
