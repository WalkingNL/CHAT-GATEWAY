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
  | { kind: "wife_help" }
  | { kind: "wife_inbox" }
  | { kind: "wife_status"; jobId: string }
  | { kind: "wife_approve"; jobId: string; selectedText: string }
  | { kind: "wife_reject"; jobId: string; reason: string }
  | { kind: "wife_skip"; jobId: string; reason: string }
  | { kind: "unknown"; raw: string };

export function parseCommand(text: string): Cmd {
  const t = String(text || "")
    .replace(/\u3000/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  if (t === "/help") return { kind: "help" };

  {
    const va = t.match(/^\/va(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i);
    if (va) {
      const rest = String(va[1] || "").trim();
      if (!rest || rest === "help") return { kind: "va_help" };
      if (rest === "inbox") return { kind: "va_inbox" };

      const m = rest.match(/^reply\s+(\S+)\s+([\s\S]+)$/i);
      if (m) {
        const contactId = String(m[1] || "").trim();
        const replyText = String(m[2] || "").trim();
        if (contactId && replyText) return { kind: "va_reply", contactId, text: replyText };
      }
      {
        const m = rest.match(/^take\s+(\S+)$/i);
        if (m) {
          const ticketId = String(m[1] || "").trim().toUpperCase();
          if (ticketId) return { kind: "va_take", ticketId };
        }
      }
      {
        const m = rest.match(/^close(?:\s+(\S+))?$/i);
        if (m) {
          const ticketId = String(m[1] || "").trim().toUpperCase();
          return { kind: "va_close", ticketId };
        }
      }
      {
        const m = rest.match(/^reject\s+(\S+)(?:\s+([\s\S]+))?$/i);
        if (m) {
          const ticketId = String(m[1] || "").trim().toUpperCase();
          const reason = String(m[2] || "").trim();
          if (ticketId) return { kind: "va_reject", ticketId, reason };
        }
      }
      {
        const m = rest.match(/^status\s+(\S+)$/i);
        if (m) {
          const ticketId = String(m[1] || "").trim().toUpperCase();
          if (ticketId) return { kind: "va_status", ticketId };
        }
      }
    }
  }

  {
    const wife = t.match(/^\/wife(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i);
    if (wife) {
      const rest = String(wife[1] || "").trim();
      if (!rest || rest === "help") return { kind: "wife_help" };
      if (rest === "inbox") return { kind: "wife_inbox" };

      {
        const m = rest.match(/^status\s+(\S+)$/i);
        if (m) {
          const jobId = String(m[1] || "").trim();
          if (jobId) return { kind: "wife_status", jobId };
        }
      }
      {
        const m = rest.match(/^approve\s+(\S+)(?:\s+([\s\S]+))?$/i);
        if (m) {
          const jobId = String(m[1] || "").trim();
          const selectedText = String(m[2] || "").trim();
          if (jobId) return { kind: "wife_approve", jobId, selectedText };
        }
      }
      {
        const m = rest.match(/^reject\s+(\S+)(?:\s+([\s\S]+))?$/i);
        if (m) {
          const jobId = String(m[1] || "").trim();
          const reason = String(m[2] || "").trim();
          if (jobId) return { kind: "wife_reject", jobId, reason };
        }
      }
      {
        const m = rest.match(/^skip\s+(\S+)(?:\s+([\s\S]+))?$/i);
        if (m) {
          const jobId = String(m[1] || "").trim();
          const reason = String(m[2] || "").trim();
          if (jobId) return { kind: "wife_skip", jobId, reason };
        }
      }
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
