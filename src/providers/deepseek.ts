import { LLMProvider, GenerateParams } from "./base.js";

export class DeepSeekProvider implements LLMProvider {
  name = "deepseek";

  constructor(
    private apiKey: string,
    private baseUrl: string,
    private model: string,
    private maxTokens: number,
    private temperature: number
  ) {}

  async generate(p: GenerateParams): Promise<string> {
    if (!this.apiKey) throw new Error("Missing DEEPSEEK_API_KEY");

    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: this.model,
      messages: p.messages,
      max_tokens: p.maxTokens ?? this.maxTokens,
      temperature: p.temperature ?? this.temperature,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`DeepSeek HTTP ${res.status}: ${txt}`);
    }

    const json: any = await res.json();
    const out = json?.choices?.[0]?.message?.content ?? "";
    return String(out).trim();
  }
}
