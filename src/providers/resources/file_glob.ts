import fs from "node:fs";
import path from "node:path";

export type FileGlobSpec = {
  baseDir: string;
  glob: string;
  maxBytes: number;
  maxLines: number;
};

export type FileGlobResult = {
  ok: boolean;
  lines: string[];
  errors?: string[];
  reason?: string;
};

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function matchGlob(name: string, glob: string): boolean {
  if (!glob.includes("*")) return name === glob;
  const parts = glob.split("*");
  const prefix = parts[0];
  const suffix = parts.slice(1).join("*");
  return name.startsWith(prefix) && name.endsWith(suffix);
}

export function readFileGlob(spec: FileGlobSpec): FileGlobResult {
  const errors: string[] = [];
  const maxLines = clamp(spec.maxLines, 1, 5000);
  const maxBytes = clamp(spec.maxBytes, 1, 10_000_000);

  let names: string[] = [];
  try {
    names = fs.readdirSync(spec.baseDir);
  } catch {
    return { ok: false, lines: [], reason: "dir_read_failed" };
  }

  const files = names.filter((n) => matchGlob(n, spec.glob));
  if (!files.length) {
    return { ok: false, lines: [], reason: "file_not_found" };
  }

  const lines: string[] = [];
  let totalBytes = 0;

  for (const f of files) {
    try {
      const full = path.join(spec.baseDir, f);
      const content = fs.readFileSync(full, "utf-8");
      const bytes = Buffer.byteLength(content, "utf-8");
      if (totalBytes + bytes > maxBytes) {
        errors.push("limit_exceeded");
        break;
      }
      totalBytes += bytes;
      const all = content.split("\n");
      const tail = all.slice(Math.max(0, all.length - maxLines));
      lines.push(...tail);
    } catch {
      errors.push("file_read_failed");
    }
  }

  return {
    ok: true,
    lines,
    ...(errors.length ? { errors: [...new Set(errors)] } : {}),
  };
}
