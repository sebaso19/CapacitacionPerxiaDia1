export type AgentTool = { name: string; description: string; input_schema: { type: "object"; properties: Record<string, unknown>; required: string[] } };
export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
export type LlmResponse = { text: string; toolCalls: ToolCall[]; raw?: unknown };
export interface LlmAdapter { provider: string; model: string; enviar(messages: Array<{ role: "user" | "assistant"; content: string }>, tools: AgentTool[]): Promise<LlmResponse>; }
