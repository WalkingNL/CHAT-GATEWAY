import { execSync } from "node:child_process";

export type Pm2Proc = {
  name: string;
  status: string;
  restarts: number;
  uptime_ms: number;
  memory: number;
  cpu: number;
};

export type Pm2PsResult = {
  ok: boolean;
  procs: Pm2Proc[];
  reason?: string;
};

export function readPm2Ps(allowedNames?: string[]): Pm2PsResult {
  let out = "";
  try {
    out = execSync("pm2 jlist", { encoding: "utf-8" });
  } catch {
    return { ok: false, procs: [], reason: "pm2_unavailable" };
  }

  let arr: any[] = [];
  try {
    arr = JSON.parse(out);
  } catch {
    return { ok: false, procs: [], reason: "pm2_parse_failed" };
  }

  const filtered = allowedNames?.length
    ? arr.filter((p) => allowedNames.includes(p?.name))
    : arr;

  const procs = filtered.map((p) => ({
    name: String(p?.name || "unknown"),
    status: String(p?.pm2_env?.status || "unknown"),
    restarts: Number(p?.pm2_env?.restart_time || 0),
    uptime_ms: Number(p?.pm2_env?.pm_uptime || 0),
    memory: Number(p?.monit?.memory || 0),
    cpu: Number(p?.monit?.cpu || 0),
  }));

  return { ok: true, procs };
}
