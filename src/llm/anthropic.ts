import Anthropic from "@anthropic-ai/sdk";
import type { AgentTool, LlmAdapter, LlmResponse } from "./adapter.js";

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;

  constructor(model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5") {
    this.model = model;
    this.client = new Anthropic();
  }

  async enviar(messages: Array<{ role: "user" | "assistant"; content: string }>, tools: AgentTool[]): Promise<LlmResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: "Responde en español y usa las herramientas para toda afirmación factual.",
      messages,
      tools
    });
    return {
      text: response.content.filter((block): block is Anthropic.TextBlock => block.type === "text").map((block) => block.text).join("\n"),
      toolCalls: response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use").map((block) => ({ id: block.id, name: block.name, input: block.input as Record<string, unknown> })),
      raw: response
    };
  }
}
