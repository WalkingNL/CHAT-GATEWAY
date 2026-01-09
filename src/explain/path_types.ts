export type ExplainInput = {
  alert_raw: string;
  parsed: any;
  facts: any;
  mode?: string;
};

export type ExplainPath = {
  id: string;
  priority: number;
  enabled?: boolean;
  match: (input: ExplainInput) => boolean;
  promptAddon: (input: ExplainInput) => string;
};
