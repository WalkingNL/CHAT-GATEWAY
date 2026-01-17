import type { LLMProvider } from "./providers/base.js";
import { DeepSeekProvider } from "./providers/deepseek.js";
import { OpenAIProvider } from "./providers/openai.js";

function toNumber(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function buildProvider(cfg: any): LLMProvider {
  const providers = cfg?.gateway?.providers ?? {};
  const name = String(providers.default || "deepseek").trim();

  if (name === "deepseek") {
    const dcfg = providers.deepseek ?? {};
    return new DeepSeekProvider(
      String(process.env.DEEPSEEK_API_KEY || ""),
      String(dcfg.base_url || "https://api.deepseek.com"),
      String(dcfg.model || "deepseek-chat"),
      toNumber(dcfg.max_tokens, 800),
      toNumber(dcfg.temperature, 0.2),
    );
  }

  if (name === "openai") {
    return new OpenAIProvider();
  }

  throw new Error(`Unknown provider: ${name}`);
}
