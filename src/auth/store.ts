import fs from "node:fs";
import path from "node:path";

export interface AuthState {
  owner_chat_id: string;
  allowed: string[];
  updated_at_utc: string;
}

export function loadAuth(storageDir: string, ownerChatId: string): AuthState {
  const p = path.join(storageDir, "auth.json");
  if (!fs.existsSync(p)) {
    const st: AuthState = {
      owner_chat_id: ownerChatId,
      allowed: [ownerChatId],
      updated_at_utc: new Date().toISOString(),
    };
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(st, null, 2), "utf-8");
    return st;
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function saveAuth(storageDir: string, st: AuthState) {
  const p = path.join(storageDir, "auth.json");
  st.updated_at_utc = new Date().toISOString();
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(st, null, 2), "utf-8");
}
