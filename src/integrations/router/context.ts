import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function sanitizeInline(value: unknown, maxLen = 120): string {
  let s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length > maxLen) s = `${s.slice(0, Math.max(0, maxLen - 3))}...`;
  return s;
}

function readFeedbackState(storageDir?: string): string[] {
  if (!storageDir) return [];
  const p = path.join(storageDir, "feedback_state.json");
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const ts = sanitizeInline(raw?.ts_utc, 32);
    const kind = sanitizeInline(raw?.kind, 16);
    const channel = sanitizeInline(raw?.channel, 16);
    const chatType = sanitizeInline(raw?.chat_type, 16);
    const source = channel && chatType ? `${channel}/${chatType}` : channel;
    const updated = raw?.updated;
    const minPriority = sanitizeInline(raw?.min_priority_next || raw?.min_priority_prev || "", 16);
    const pushLevel = raw?.push_level_next ?? raw?.push_level_prev;
    const target = raw?.target_next ?? raw?.target_prev;
    const cooldown = raw?.cooldown_remaining_sec;
    const version = raw?.policy_version;
    const err = sanitizeInline(raw?.error, 120);
    const parts = [
      ts ? `ts=${ts}` : null,
      kind ? `kind=${kind}` : null,
      source ? `source=${source}` : null,
      typeof updated === "boolean" ? `updated=${updated}` : null,
      minPriority ? `min_priority=${minPriority}` : null,
      Number.isFinite(Number(pushLevel)) ? `push_level=${pushLevel}` : null,
      Number.isFinite(Number(target)) ? `target_per_hour=${target}` : null,
      Number.isFinite(Number(cooldown)) ? `cooldown_remaining_sec=${cooldown}` : null,
      Number.isFinite(Number(version)) ? `policy_version=${version}` : null,
      err ? `error=${err}` : null,
    ].filter(Boolean);
    if (!parts.length) return [];
    return [`- feedback: ${parts.join(" ")}`];
  } catch {
    return ["- feedback: unreadable_state"];
  }
}

export function getStatusFacts(storageDir?: string): string {
  const lines: string[] = [];
  try {
    const head = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
    lines.push(`- git: ${head}`);
  } catch {}

  lines.push(...readFeedbackState(storageDir));
  return ["✅ status (facts-only)", ...lines].join("\n");
}
