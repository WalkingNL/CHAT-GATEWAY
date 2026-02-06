export type ExplicitIntentKind = "alert_explain" | "news_summary";

export type ExplicitIntentMatch = {
  kind: ExplicitIntentKind;
  source: "keyword";
};

const NEWS_SUMMARY_KEYWORDS = ["摘要", "总结", "概括", "简要", "简述"];

export function wantsNewsSummary(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  return NEWS_SUMMARY_KEYWORDS.some(k => t.includes(k));
}

export function isExplainRequest(text: string): boolean {
  const t = String(text || "").trim();
  return t === "解释一下" || t === "解释" || t === "解释下";
}

export function resolveExplicitIntent(text: string): ExplicitIntentMatch | null {
  if (isExplainRequest(text)) return { kind: "alert_explain", source: "keyword" };
  if (wantsNewsSummary(text)) return { kind: "news_summary", source: "keyword" };
  return null;
}
