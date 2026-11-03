import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { RegistroProveedorAgent } from "./agent.js";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agent = RegistroProveedorAgent.configured(directory);
const app = new Hono();

app.get("/api/health", (context) => context.json({ ok: true, provider: process.env.ANTHROPIC_API_KEY ? "anthropic" : "deterministic", model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5" }));
app.get("/api/sessions/:id", (context) => context.json(agent.getSession(context.req.param("id"))));
app.post("/api/chat", async (context) => {
  try { return context.json(await agent.chat(await context.req.json())); }
  catch (error) { return context.json({ error: error instanceof Error ? error.message : "Solicitud inválida" }, 400); }
});
app.use("/*", serveStatic({ root: "./web" }));
app.get("*", serveStatic({ root: "./web", path: "index.html" }));

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
