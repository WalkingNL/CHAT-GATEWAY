import fs from "node:fs";
import path from "node:path";

export interface AuthState {
  owner_chat_id: string;
  allowed: string[];
  updated_at_utc: string;
}

function authPath(storageDir: string, channel: string) {
  return path.join(storageDir, `auth_${channel}.json`);
}

export function loadAuth(storageDir: string, ownerChatId: string, channel = "telegram"): AuthState {
  const p = authPath(storageDir, channel);
  const legacy = path.join(storageDir, "auth.json");
  const useLegacy = !fs.existsSync(p) && fs.existsSync(legacy);
  const readPath = useLegacy ? legacy : p;
  if (!fs.existsSync(readPath)) {
    const st: AuthState = {
      owner_chat_id: ownerChatId,
      allowed: [ownerChatId],
      updated_at_utc: new Date().toISOString(),
    };
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(st, null, 2), "utf-8");
    return st;
  }
  return JSON.parse(fs.readFileSync(readPath, "utf-8"));
}

export function saveAuth(storageDir: string, st: AuthState, channel = "telegram") {
  const p = authPath(storageDir, channel);
  st.updated_at_utc = new Date().toISOString();
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(st, null, 2), "utf-8");
}
