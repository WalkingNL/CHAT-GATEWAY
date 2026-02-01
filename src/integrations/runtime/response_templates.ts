import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

type Template = {
  zh: string;
  en: string;
};

type ResponseTemplates = {
  version: string;
  templates: Record<string, Template>;
};

const DEFAULT_TEMPLATES: ResponseTemplates = {
  version: "v1",
  templates: {
    error: { zh: "处理失败：{reason}", en: "Failed to process: {reason}" },
    reject: { zh: "已拒绝：{reason}", en: "Rejected: {reason}" },
    clarify: { zh: "需要澄清：{question}", en: "Need clarification: {question}" },
  },
};

let cachedTemplates: ResponseTemplates | null = null;

function resolveTemplatesPath(): string {
  const override = String(
    process.env.CHAT_GATEWAY_RESPONSE_TEMPLATES_PATH || process.env.RESPONSE_TEMPLATES_PATH || "",
  ).trim();
  if (override) return override;
  return path.join("config", "response_templates.yaml");
}

function normalizeTemplate(raw: any): Template | null {
  if (!raw || typeof raw !== "object") return null;
  const zh = String((raw as any).zh || "").trim();
  const en = String((raw as any).en || "").trim();
  if (!zh || !en) return null;
  return { zh, en };
}

function loadTemplates(): ResponseTemplates {
  if (cachedTemplates) return cachedTemplates;
  const filePath = resolveTemplatesPath();
  let data: any = null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    data = YAML.parse(raw);
  } catch {
    cachedTemplates = DEFAULT_TEMPLATES;
    return cachedTemplates;
  }

  if (!data || typeof data !== "object") {
    cachedTemplates = DEFAULT_TEMPLATES;
    return cachedTemplates;
  }

  const version = String(data.version || "").trim() || DEFAULT_TEMPLATES.version;
  const templates = data.templates && typeof data.templates === "object" ? data.templates : {};
  const merged: ResponseTemplates = {
    version,
    templates: { ...DEFAULT_TEMPLATES.templates },
  };
  for (const [key, rawTemplate] of Object.entries(templates)) {
    const normalized = normalizeTemplate(rawTemplate);
    if (normalized) merged.templates[key] = normalized;
  }

  cachedTemplates = merged;
  return cachedTemplates;
}

function resolveLang(explicit?: string): "zh" | "en" {
  const raw = String(
    explicit
      || process.env.CHAT_GATEWAY_RESPONSE_LANG
      || process.env.GW_RESPONSE_LANG
      || "zh",
  )
    .trim()
    .toLowerCase();
  return raw.startsWith("en") ? "en" : "zh";
}

function renderTemplate(text: string, params: Record<string, string>): string {
  return text.replace(/\{([^}]+)\}/g, (_m, key) => {
    const val = params[key];
    return val == null ? "" : String(val);
  });
}

export function formatResponse(
  kind: "error" | "reject" | "clarify",
  params: { reason?: string; question?: string },
  opts?: { lang?: string },
): string {
  const templates = loadTemplates();
  const template = templates.templates[kind] || DEFAULT_TEMPLATES.templates[kind];
  const lang = resolveLang(opts?.lang);
  const text = (template as any)[lang] || template.zh;
  return renderTemplate(text, {
    reason: String(params.reason || "").trim(),
    question: String(params.question || "").trim(),
  }).trim();
}

export function errorText(reason: string, opts?: { lang?: string }): string {
  return formatResponse("error", { reason }, opts);
}

export function rejectText(reason: string, opts?: { lang?: string }): string {
  return formatResponse("reject", { reason }, opts);
}

export function clarifyText(question: string, opts?: { lang?: string }): string {
  return formatResponse("clarify", { question }, opts);
}
