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
  "你是告警解释助手，只能使用 alert_raw 与 context 中的 facts/parsed 信息，禁止编造。\n" +
  "请输出中文，简短清晰（建议 120-220 字），不要编号/列表，语气自然不机械。\n" +
  "必须输出两行：\n" +
  "系统内部解释：用人话串联 Event/Strength/Evidence/Context/Risk，不要逐条复述；缺字段要说明“数据缺失”。\n" +
  "系统外部解释：仅当 context 中有明确外部证据时输出，否则写“当前暂无”。\n" +
  "禁止：价格预测、交易建议、无依据故事。\n" +
  "若 facts.window_1h/24h/symbol_recent.ok 为 true，内部解释必须引用；为 false 才能说明窗口查询失败及其原因。\n" +
  "若 facts.warnings 中仅有 history_truncated（或仅见 limit_exceeded），只可表述为“历史样本截断/对照样本不完整”，禁止写成“窗口查询失败”。\n" +
  "若 facts.warnings 包含 history_empty，表述为“近窗口无可用历史样本”，禁止写成“窗口查询失败”。\n";

export type RouterDecision = {
  selected_paths: string[];
  prompt: string;
  context: ExplainInput;
};

export function routeExplain(input: ExplainInput): RouterDecision {
  ensurePathsRegistered();
  const paths = pickPaths(input, 2);
  const addons = paths
    .map((p) => p.promptAddon(input))
    .filter(Boolean)
    .map((text) => `提示（仅供参考，不要直接引用）：${text}`);
  const selected = paths.length ? paths.map((p) => p.id) : ["default"];
  const prompt = addons.length ? [BASE_PROMPT, ...addons].join("\n\n") : BASE_PROMPT;

  return {
    selected_paths: selected,
    prompt,
    context: input,
  };
}
