import { execSync } from "node:child_process";

export function getStatusFacts(): string {
  const lines: string[] = [];
  try {
    const head = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
    lines.push(`- git: ${head}`);
  } catch {}

  return ["✅ status (facts-only)", ...lines].join("\n");
}
