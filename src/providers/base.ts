export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GenerateParams {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface LLMProvider {
  name: string;
  generate(p: GenerateParams): Promise<string>;
}
