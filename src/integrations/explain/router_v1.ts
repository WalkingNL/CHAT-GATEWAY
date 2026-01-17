import type { ExplainInput } from "./path_types.js";
import { pickPaths } from "./path_registry.js";
import { registerDefaultPaths } from "./paths/index.js";

let initialized = false;

function ensurePathsRegistered() {
  if (initialized) return;
  registerDefaultPaths();
  initialized = true;
}

const BASE_PROMPT =
  "解释这条告警（facts-only）：\n" +
  "1) 发生了什么（用人话）\n" +
  "2) 关键结构特征（如量价背离/稳定币）\n" +
  "3) 可能原因（推断要写依据+置信度）\n" +
  "4) 下一步建议看什么（facts-only，不给交易建议）\n" +
  "禁止：价格预测、买卖建议、无依据故事。\n" +
  "If facts.window_1h/24h/symbol_recent.ok is true, you MUST reference them. " +
  "If false, explicitly say what is missing.\n";

export type RouterDecision = {
  selected_paths: string[];
  prompt: string;
  context: ExplainInput;
};

export function routeExplain(input: ExplainInput): RouterDecision {
  ensurePathsRegistered();
  const paths = pickPaths(input, 2);
  const addons = paths.map((p) => p.promptAddon(input)).filter(Boolean);
  const selected = paths.length ? paths.map((p) => p.id) : ["default"];
  const prompt = addons.length ? [BASE_PROMPT, ...addons].join("\n\n") : BASE_PROMPT;

  return {
    selected_paths: selected,
    prompt,
    context: input,
  };
}
