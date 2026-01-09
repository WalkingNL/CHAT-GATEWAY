import type { LoadedConfig } from "./types.js";

type EvalInput = {
  channel: "telegram";
  capability: "alerts.explain" | "ops.help" | string;
  chat_id: string;
  chat_type: "private" | "group" | "supergroup";
  user_id: string;
  mention_bot: boolean;
  has_reply: boolean;
};

type EvalResult = {
  allowed: boolean;
  deny_message?: string;
  require?: {
    mention_bot_for_explain?: boolean;
    reply_required_for_explain?: boolean;
  };
  limits?: {
    rpm?: number;
    max_lines?: number;
    max_chars?: number;
  };
  reason?: string;
};

function matchRule(rule: any, inp: EvalInput): boolean {
  const m = rule?.match || {};
  if (m.channel && m.channel !== inp.channel) return false;
  if (m.chat_id && String(m.chat_id) !== String(inp.chat_id)) return false;
  if (m.chat_type && String(m.chat_type) !== String(inp.chat_type)) return false;
  if (m.user_id && String(m.user_id) !== String(inp.user_id)) return false;
  return true;
}

export function evaluate(cfg: LoadedConfig | undefined, inp: EvalInput): EvalResult {
  const policy = cfg?.policy || ({} as any);
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const def = policy.default || {};

  const defaultRes: EvalResult = {
    allowed: false,
    deny_message: "not allowed",
    limits: {
      rpm: def?.rate_limit?.rpm ?? 30,
      max_lines: def?.output_limits?.max_lines ?? 60,
      max_chars: def?.output_limits?.max_chars ?? 6000,
    },
  };

  for (const r of rules) {
    if (!matchRule(r, inp)) continue;

    const allow = Array.isArray(r.allow) ? r.allow : [];
    const allowed = allow.includes("*") || allow.includes(inp.capability);

    const require = r.require || {};
    const deny_message = r.deny_message || undefined;

    if (!allowed) {
      return { ...defaultRes, allowed: false, deny_message, reason: "not_allowed" };
    }

    if (inp.capability === "alerts.explain") {
      const needMention = !!require.mention_bot_for_explain;
      const needReply = !!require.reply_required_for_explain;

      if (needMention && !inp.mention_bot) {
        return { ...defaultRes, allowed: false, deny_message: undefined, require, reason: "missing_mention" };
      }
      if (needReply && !inp.has_reply) {
        return { ...defaultRes, allowed: false, deny_message: undefined, require, reason: "missing_reply" };
      }
    }

    return {
      allowed: true,
      deny_message: undefined,
      require,
      limits: {
        rpm: r?.rate_limit?.rpm ?? defaultRes.limits?.rpm,
        max_lines: r?.output_limits?.max_lines ?? defaultRes.limits?.max_lines,
        max_chars: r?.output_limits?.max_chars ?? defaultRes.limits?.max_chars,
      },
    };
  }

  return defaultRes;
}
