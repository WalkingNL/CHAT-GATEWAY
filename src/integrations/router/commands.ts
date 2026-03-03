export type Cmd =
  | { kind: "help" }
  | { kind: "auth_add"; id: string }
  | { kind: "auth_del"; id: string }
  | { kind: "auth_list" }
  | { kind: "va_help" }
  | { kind: "va_reply"; contactId: string; text: string }
  | { kind: "va_inbox" }
  | { kind: "va_take"; ticketId: string }
  | { kind: "va_close"; ticketId: string }
  | { kind: "va_reject"; ticketId: string; reason: string }
  | { kind: "va_status"; ticketId: string }
  | { kind: "unknown"; raw: string };

export function parseCommand(text: string): Cmd {
  const t = (text || "").trim();

  if (t === "/help") return { kind: "help" };

  if (t === "/va" || t === "/va help") return { kind: "va_help" };
  if (t === "/va inbox") return { kind: "va_inbox" };
  {
    const m = t.match(/^\/va\s+reply\s+(\S+)\s+([\s\S]+)$/);
    if (m) {
      const contactId = String(m[1] || "").trim();
      const replyText = String(m[2] || "").trim();
      if (contactId && replyText) return { kind: "va_reply", contactId, text: replyText };
    }
  }
  {
    const m = t.match(/^\/va\s+take\s+(\S+)$/);
    if (m) {
      const ticketId = String(m[1] || "").trim().toUpperCase();
      if (ticketId) return { kind: "va_take", ticketId };
    }
  }
  {
    const m = t.match(/^\/va\s+close(?:\s+(\S+))?$/);
    if (m) {
      const ticketId = String(m[1] || "").trim().toUpperCase();
      return { kind: "va_close", ticketId };
    }
  }
  {
    const m = t.match(/^\/va\s+reject\s+(\S+)(?:\s+([\s\S]+))?$/);
    if (m) {
      const ticketId = String(m[1] || "").trim().toUpperCase();
      const reason = String(m[2] || "").trim();
      if (ticketId) return { kind: "va_reject", ticketId, reason };
    }
  }
  {
    const m = t.match(/^\/va\s+status\s+(\S+)$/);
    if (m) {
      const ticketId = String(m[1] || "").trim().toUpperCase();
      if (ticketId) return { kind: "va_status", ticketId };
    }
  }

  if (t.startsWith("/auth")) {
    const parts = t.split(/\s+/);
    if (parts[1] === "add" && parts[2]) return { kind: "auth_add", id: parts[2] };
    if (parts[1] === "del" && parts[2]) return { kind: "auth_del", id: parts[2] };
    if (parts[1] === "list") return { kind: "auth_list" };
  }

  return { kind: "unknown", raw: t };
}
