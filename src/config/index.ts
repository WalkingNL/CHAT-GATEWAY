import type {
  PolicyConfig,
  PolicyDecision,
  PolicyInput,
  PolicyRequire,
  ProjectManifest,
} from "./types.js";
import { loadPolicy, loadProjects } from "./loader.js";

function getByPath(obj: any, path: string): any {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function resolveTemplate(value: string, policy: PolicyConfig): string {
  return value.replace(/\$\{([^}]+)\}/g, (_m, key) => {
    const v = getByPath(policy, String(key).trim());
    return v == null ? "" : String(v);
  });
}

function matchRule(input: PolicyInput, policy: PolicyConfig, match: PolicyConfig["rules"][number]["match"]): boolean {
  for (const [key, raw] of Object.entries(match || {})) {
    const expected = typeof raw === "string" ? resolveTemplate(raw, policy) : raw;
    const actual = (input as any)[key];
    if (expected === "") return false;
    if (actual == null) return false;
    if (String(actual) !== String(expected)) return false;
  }
  return true;
}

function defaultLimits(policy: PolicyConfig) {
  return {
    rpm: policy.default?.rate_limit?.rpm,
    max_lines: policy.default?.output_limits?.max_lines,
    max_chars: policy.default?.output_limits?.max_chars,
  };
}

function applyRequire(
  input: PolicyInput,
  require: PolicyRequire | undefined,
  decision: PolicyDecision,
): PolicyDecision {
  if (!require) return decision;

  const isExplain = input.capability === "alerts.explain";
  const isOps = input.capability.startsWith("ops.");

  if (isExplain) {
    if (require.mention_bot_for_explain && !input.mentions_bot) {
      return { ...decision, allowed: false, reason: "missing_mention" };
    }
    if (require.reply_required_for_explain && !input.has_reply) {
      return { ...decision, allowed: false, reason: "missing_reply" };
    }
  }

  if (isOps) {
    if (require.mention_bot_for_ops && !input.mentions_bot) {
      return { ...decision, allowed: false, reason: "missing_mention" };
    }
  }

  return decision;
}

export function defaultPolicy(): PolicyConfig {
  return {
    version: 1,
    enabled: true,
    principals: {
      owner: {
        telegram_user_id: "",
        telegram_owner_chat_id: "",
        feishu_user_id: "",
        feishu_owner_chat_id: "",
      },
      allowlist: {
        telegram_user_ids: [],
        telegram_chat_ids: [],
        feishu_user_ids: [],
        feishu_chat_ids: [],
      },
    },
    capabilities: ["alerts.explain", "ops.help"],
    default: {
      allow: [],
      rate_limit: { rpm: 30 },
      output_limits: { max_lines: 60, max_chars: 6000 },
    },
    rules: [
      {
        name: "owner_dm_fallback",
        match: {
          channel: "telegram",
          chat_type: "private",
          user_id: "${principals.owner.telegram_user_id}",
        },
        allow: ["alerts.explain", "ops.help"],
        require: {
          mention_bot_for_explain: false,
          reply_required_for_explain: false,
          mention_bot_for_ops: false,
        },
      },
      {
        name: "owner_dm_fallback_feishu",
        match: {
          channel: "feishu",
          chat_type: "private",
          user_id: "${principals.owner.feishu_user_id}",
        },
        allow: ["alerts.explain", "ops.help"],
        require: {
          mention_bot_for_explain: false,
          reply_required_for_explain: false,
          mention_bot_for_ops: false,
        },
      },
    ],
  };
}

export function loadAllConfig(opts?: {
  policyPath?: string;
  projectsDir?: string;
}): {
  policy: PolicyConfig;
  projects: Record<string, ProjectManifest>;
  meta: { policyOk: boolean; projectsCount: number; errors: string[] };
} {
  const policyPath = opts?.policyPath || "config/policy.yml";
  const projectsDir = opts?.projectsDir || "config/projects.d";

  const errors: string[] = [];

  const policyRes = loadPolicy(policyPath);
  const policy = policyRes.ok && policyRes.data ? policyRes.data : defaultPolicy();
  if (!policyRes.ok && policyRes.error) errors.push(policyRes.error);

  const projectsRes = loadProjects(projectsDir);
  if (projectsRes.errors.length) errors.push(...projectsRes.errors);

  return {
    policy,
    projects: projectsRes.data,
    meta: {
      policyOk: policyRes.ok,
      projectsCount: Object.keys(projectsRes.data).length,
      errors,
    },
  };
}

export function evaluatePolicy(input: PolicyInput, policy: PolicyConfig): PolicyDecision {
  const limits = defaultLimits(policy);

  if (!policy.enabled) {
    return { allowed: false, denyMessage: "policy_disabled", limits, reason: "not_allowed" };
  }

  for (const rule of policy.rules || []) {
    if (!matchRule(input, policy, rule.match)) continue;

    const allowed = (rule.allow || []).includes(input.capability);
    const decision: PolicyDecision = {
      allowed,
      denyMessage: allowed ? undefined : rule.deny_message,
      limits: {
        rpm: rule.rate_limit?.rpm ?? limits.rpm,
        max_lines: rule.output_limits?.max_lines ?? limits.max_lines,
        max_chars: rule.output_limits?.max_chars ?? limits.max_chars,
      },
      require: rule.require,
      reason: allowed ? undefined : "not_allowed",
    };

    const gated = applyRequire(input, rule.require, decision);
    if (!gated.allowed && gated.reason && !gated.denyMessage) {
      return { ...gated, denyMessage: rule.deny_message };
    }

    return gated;
  }

  const defaultAllowed = (policy.default?.allow || []).includes(input.capability);
  return {
    allowed: defaultAllowed,
    denyMessage: defaultAllowed ? undefined : "not_allowed",
    limits,
    reason: defaultAllowed ? undefined : "not_allowed",
  };
}

export { evaluate } from "./eval.js";
