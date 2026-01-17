import { LLMProvider, GenerateParams } from "./base.js";

export class OpenAIProvider implements LLMProvider {
  name = "openai";
  async generate(_: GenerateParams): Promise<string> {
    throw new Error("OpenAIProvider not implemented (stub)");
  }
}
