export type ResourceDef = {
  type: string;
  [key: string]: any;
};

export type ProjectManifest = {
  version?: number;
  project_id: string;
  display_name?: string;
  kind?: string;
  enabled?: boolean;
  root: string;
  resources: Record<string, ResourceDef>;
  deny?: string[];
  limits?: {
    max_total_bytes?: number;
    max_total_lines?: number;
    max_total_files?: number;
  };
  notes?: Record<string, any>;
};

export type PolicyPrincipals = {
  owner?: {
    telegram_user_id?: string;
    telegram_owner_chat_id?: string;
  };
  allowlist?: {
    telegram_user_ids?: string[];
    telegram_chat_ids?: string[];
  };
};

export type PolicyRequire = {
  mention_bot_for_explain?: boolean;
  reply_required_for_explain?: boolean;
  mention_bot_for_ops?: boolean;
};

export type PolicyRule = {
  name: string;
  match: {
    channel?: string;
    chat_id?: string;
    chat_type?: string;
    user_id?: string;
  };
  allow: string[];
  require?: PolicyRequire;
  rate_limit?: { rpm?: number };
  output_limits?: { max_lines?: number; max_chars?: number };
  deny_message?: string;
};

export type PolicyConfig = {
  version?: number;
  enabled?: boolean;
  principals: PolicyPrincipals;
  capabilities?: string[];
  default: {
    allow?: string[];
    rate_limit?: { rpm?: number };
    output_limits?: { max_lines?: number; max_chars?: number };
  };
  rules: PolicyRule[];
};

export type PolicyInput = {
  channel: string;
  chat_id: string;
  chat_type?: string;
  user_id: string;
  is_group?: boolean;
  mentions_bot?: boolean;
  has_reply?: boolean;
  capability: string;
};

export type PolicyDecision = {
  allowed: boolean;
  denyMessage?: string;
  limits: { rpm?: number; max_lines?: number; max_chars?: number };
  require?: PolicyRequire;
  reason?: string;
};

export type LoadedConfig = {
  policy: PolicyConfig;
  projects: Record<string, ProjectManifest>;
  meta: { policyOk: boolean; projectsCount: number; errors: string[] };
};
