import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Pm2LogsSpec = {
  name: string;
  lines: number;
};

export type Pm2LogsResult = {
  ok: boolean;
  out?: string;
  err?: string;
  reason?: string;
};

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function tailLines(filePath: string, n: number): string {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

function resolveLogPath(name: string, stream: "out" | "error") {
  const base = path.join(os.homedir(), ".pm2", "logs");
  return path.join(base, `${name}-${stream}.log`);
}

export function readPm2Logs(spec: Pm2LogsSpec): Pm2LogsResult {
  const n = clamp(spec.lines, 1, 5000);
  const outPath = resolveLogPath(spec.name, "out");
  const errPath = resolveLogPath(spec.name, "error");

  let any = false;
  let out: string | undefined;
  let err: string | undefined;

  if (fs.existsSync(errPath)) {
    err = tailLines(errPath, n);
    any = true;
  }
  if (fs.existsSync(outPath)) {
    out = tailLines(outPath, n);
    any = true;
  }

  if (!any) {
    return { ok: false, reason: "file_not_found" };
  }

  return { ok: true, out, err };
}
