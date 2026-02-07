export type Cmd =
  | { kind: "help" }
  | { kind: "auth_add"; id: string }
  | { kind: "auth_del"; id: string }
  | { kind: "auth_list" }
  | { kind: "unknown"; raw: string };

export function parseCommand(text: string): Cmd {
  const t = (text || "").trim();

  if (t === "/help") return { kind: "help" };

  if (t.startsWith("/auth")) {
    const parts = t.split(/\s+/);
    if (parts[1] === "add" && parts[2]) return { kind: "auth_add", id: parts[2] };
    if (parts[1] === "del" && parts[2]) return { kind: "auth_del", id: parts[2] };
    if (parts[1] === "list") return { kind: "auth_list" };
  }

  return { kind: "unknown", raw: t };
}
