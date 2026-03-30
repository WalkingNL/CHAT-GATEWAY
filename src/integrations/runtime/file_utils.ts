import fs from "node:fs";
import path from "node:path";

export function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function resolveConfigPath(envVar: string, defaultFile: string): string {
  const override = String(process.env[envVar] || "").trim();
  if (override) return override;
  return path.join("config", defaultFile);
}
