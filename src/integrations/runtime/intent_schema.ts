export const INTENT_SCHEMA_VERSION = "v1";
export const INTENT_VERSION = "v1";
export const EXPORT_API_VERSION = "v1";

export type PanelId = string;

export type DashboardExportParams = {
  panel_id: PanelId | null;
  window_spec_id: string | null;
  filters: Record<string, any>;
  export_api_version: string;
};

export type IntentParseResult = {
  intent: "dashboard_export";
  params: DashboardExportParams;
  confidence: number;
  schema_version: string;
  intent_version: string;
  raw_query: string;
  missing: string[];
  errors: string[];
  explicit_panel_id: boolean;
  window_spec_id_source: "explicit" | "default" | "missing";
};

function extractPanelId(text: string): string | null {
  const match = String(text || "").match(/\bpanel(?:_id|id)?\s*[:=]\s*([A-Za-z0-9._-]+)\b/i);
  if (!match) return null;
  return match[1];
}

function extractWindowSpecId(text: string): string | null {
  const match = String(text || "").match(/\b(?:window_spec_id|windowspecid|wsid|window_spec)\s*[:=]\s*([A-Za-z0-9._:-]{6,80})\b/i);
  if (!match) return null;
  return match[1];
}

export function parseDashboardIntent(
  text: string,
  opts?: { defaultWindowSpecId?: string; now?: Date },
): IntentParseResult | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const errors: string[] = [];
  const missing: string[] = [];
  const explicitPanelId = extractPanelId(raw);
  const panelId: PanelId | null = explicitPanelId ? explicitPanelId : null;

  if (!panelId && !explicitPanelId && errors.length === 0) return null;

  const filters: Record<string, any> = {};

  const explicitWindowSpecId = extractWindowSpecId(raw);
  const defaultWindowSpecId = String(opts?.defaultWindowSpecId || "").trim();
  const windowSpecId = explicitWindowSpecId || defaultWindowSpecId || null;
  let windowSpecIdSource: "explicit" | "default" | "missing" = "missing";
  if (explicitWindowSpecId) {
    windowSpecIdSource = "explicit";
  } else if (windowSpecId) {
    windowSpecIdSource = "default";
  }

  let confidence = 0.4;
  if (panelId) confidence += 0.2;
  if (windowSpecId) confidence += 0.2;
  if (missing.includes("window_spec_id")) confidence -= 0.2;
  if (errors.length) confidence -= 0.2;
  confidence = Math.max(0, Math.min(0.95, confidence));

  return {
    intent: "dashboard_export",
    params: {
      panel_id: panelId,
      window_spec_id: windowSpecId,
      filters,
      export_api_version: EXPORT_API_VERSION,
    },
    confidence,
    schema_version: INTENT_SCHEMA_VERSION,
    intent_version: INTENT_VERSION,
    raw_query: raw,
    missing,
    errors,
    explicit_panel_id: Boolean(explicitPanelId),
    window_spec_id_source: windowSpecIdSource,
  };
}
