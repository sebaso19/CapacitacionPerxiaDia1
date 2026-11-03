import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AnthropicAdapter } from "./llm/anthropic.js";
import type { AgentTool, LlmAdapter } from "./llm/adapter.js";
import { proveedorTools, type ToolContext } from "./tools/proveedor.js";

type VisibleToolCall = { name: string; args: Record<string, unknown>; result: { ok: boolean; summary: string } };
type Session = { messages: Array<{ role: "user" | "assistant"; content: string }>; pendingConfirmation?: string };
const sessions = new Map<string, Session>();
const inputSchema = z.object({ sessionId: z.string().min(1), message: z.string().min(1).max(4000) });
const toolCatalog: AgentTool[] = Object.entries(proveedorTools).map(([name, tool]) => ({ name: `proveedor_${name}`, description: tool.description, input_schema: { type: "object", properties: Object.fromEntries(Object.entries(tool.args).map(([key, value]) => [key, { type: "string", description: value.description }])), required: Object.keys(tool.args) } }));

function summary(result: string): { ok: boolean; summary: string } { try { const parsed = JSON.parse(result) as { ok: boolean; data?: unknown; error?: string }; return { ok: parsed.ok, summary: parsed.ok ? JSON.stringify(parsed.data).slice(0, 260) : parsed.error ?? "Error" }; } catch { return { ok: false, summary: "Respuesta inválida de herramienta" }; } }
function parseCase(message: string): string | undefined { return message.match(/(?:caso\s*["“']?)([a-z0-9-]+)/i)?.[1] ?? message.match(/\b(co-industrias-delta|ec-corp-andina|hn-agroexport-sula|pa-logistica-istmo)\b/i)?.[1]; }
function confirmed(message: string): boolean { return /^(sí|si|confirmo|confirmado|envía|enviar|procede|adelante)\b/i.test(message.trim()); }
async function logTurn(directory: string, sessionId: string, calls: VisibleToolCall[]): Promise<void> {
  if (!calls.length) return;
  const target = join(directory, "out", "log.jsonl");
  await mkdir(join(directory, "out"), { recursive: true });
  await appendFile(target, calls.map((call) => JSON.stringify({ ts: new Date().toISOString(), sessionId, herramienta: call.name, ok: call.result.ok, resumen: call.result.summary })).join("\n") + "\n");
}

export class RegistroProveedorAgent {
  constructor(private readonly directory: string, private readonly adapter?: LlmAdapter) {}

  async chat(payload: unknown): Promise<{ reply: string; toolCalls: VisibleToolCall[]; needsConfirmation: boolean }> {
    const { sessionId, message } = inputSchema.parse(payload);
    const session = sessions.get(sessionId) ?? { messages: [] };
    const ctx: ToolContext = { directory: this.directory, sessionId };
    const caseName = parseCase(message);
    const calls: VisibleToolCall[] = [];

    if (session.pendingConfirmation && confirmed(message)) {
      const result = await proveedorTools.simular_envio.execute({ caso: session.pendingConfirmation, confirmado: true }, ctx);
      calls.push({ name: "proveedor_simular_envio", args: { caso: session.pendingConfirmation, confirmado: true }, result: summary(result) });
      const sentCase = session.pendingConfirmation;
      session.pendingConfirmation = undefined;
      session.messages.push({ role: "user", content: message }, { role: "assistant", content: "Se creó el envío simulado." });
      sessions.set(sessionId, session);
      await logTurn(this.directory, sessionId, calls);
      return { reply: `Se generó el envío simulado para ${sentCase}. No se envió ningún correo real.`, toolCalls: calls, needsConfirmation: false };
    }

    if (caseName) {
      const read = await proveedorTools.leer_solicitud.execute({ caso: caseName }, ctx);
      calls.push({ name: "proveedor_leer_solicitud", args: { caso: caseName }, result: summary(read) });
      const parsed = JSON.parse(read) as { ok: boolean; data?: { campos: string[]; formato: string; cliente: string } };
      if (!parsed.ok || !parsed.data) return { reply: "No fue posible leer el caso solicitado. Verifica el nombre y vuelve a intentarlo.", toolCalls: calls, needsConfirmation: false };
      const mapped = await proveedorTools.mapear_campos.execute({ caso: caseName, campos: parsed.data.campos }, ctx);
      calls.push({ name: "proveedor_mapear_campos", args: { caso: caseName, campos: parsed.data.campos }, result: summary(mapped) });
      const mapping = JSON.parse(mapped) as { data: { llenos: unknown[]; faltantes: Array<{ etiqueta: string }>; requiere_confirmacion: Array<{ etiqueta: string }> } };
      const generated = await proveedorTools.generar_formulario.execute({ caso: caseName, mapeo: mapping.data }, ctx);
      calls.push({ name: "proveedor_generar_formulario", args: { caso: caseName, mapeo: mapping.data }, result: summary(generated) });
      const packaged = await proveedorTools.armar_paquete.execute({ caso: caseName }, ctx);
      calls.push({ name: "proveedor_armar_paquete", args: { caso: caseName }, result: summary(packaged) });
      const packageData = JSON.parse(packaged) as { data: { listo_para_firma: boolean; ruta: string } };
      session.pendingConfirmation = caseName;
      session.messages.push({ role: "user", content: message }, { role: "assistant", content: "Caso procesado." });
      sessions.set(sessionId, session);
      const missing = mapping.data.faltantes.map((item) => item.etiqueta);
      const confirmations = mapping.data.requiere_confirmacion.map((item) => item.etiqueta);
      await logTurn(this.directory, sessionId, calls);
      return { reply: `Procesé ${caseName}. Formulario y paquete creados en ${packageData.data.ruta}. ${missing.length ? `Faltantes: ${missing.join(", ")}.` : "No hay campos faltantes."} ${confirmations.length ? `Requieren confirmación: ${confirmations.join(", ")}.` : ""} Estado para firma: ${packageData.data.listo_para_firma ? "listo" : "bloqueado por soportes"}. ¿Confirmas que deseas crear el envío simulado?`, toolCalls: calls, needsConfirmation: true };
    }

    if (this.adapter && process.env.ANTHROPIC_API_KEY) {
      try {
        const answer = await this.adapter.enviar([...session.messages, { role: "user", content: message }], toolCatalog);
        session.messages.push({ role: "user", content: message }, { role: "assistant", content: answer.text });
        sessions.set(sessionId, session);
        return { reply: answer.text || "Indica el nombre de uno de los casos disponibles para procesarlo.", toolCalls: [], needsConfirmation: false };
      } catch { }
    }
    return { reply: "Indica un caso para procesar: co-industrias-delta, ec-corp-andina, hn-agroexport-sula o pa-logistica-istmo.", toolCalls: [], needsConfirmation: false };
  }

  getSession(sessionId: string): Session { return sessions.get(sessionId) ?? { messages: [] }; }
  static configured(directory: string): RegistroProveedorAgent { return new RegistroProveedorAgent(directory, process.env.ANTHROPIC_API_KEY ? new AnthropicAdapter() : undefined); }
}
