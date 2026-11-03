import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export interface ToolContext {
  directory: string;
  sessionId: string;
}

type Formato = "xlsx" | "pdf" | "portal";
type Solicitado = { etiqueta: string; obligatorio?: boolean; hoja?: string; celda_etiqueta?: string; celda_valor?: string };
type MapeoItem = { etiqueta: string; estado: "lleno" | "faltante" | "requiere_confirmacion"; ruta?: string; valor?: string | number | boolean; nota?: string; confianza: number };
type Mapeo = { llenos: MapeoItem[]; faltantes: MapeoItem[]; requiere_confirmacion: MapeoItem[] };

const argsCaso = z.object({ caso: z.string().min(1).describe("Nombre de la carpeta dentro de casos/") });
const argsMapeo = z.object({ caso: z.string().min(1).describe("Nombre de la carpeta del caso"), campos: z.array(z.string()).describe("Etiquetas solicitadas por la plantilla") });
const argsFormulario = z.object({ caso: z.string().min(1).describe("Nombre de la carpeta del caso"), mapeo: z.object({ llenos: z.array(z.unknown()), faltantes: z.array(z.unknown()), requiere_confirmacion: z.array(z.unknown()) }).describe("Resultado devuelto por proveedor_mapear_campos") });
const argsEnvio = z.object({ caso: z.string().min(1).describe("Nombre de la carpeta del caso"), confirmado: z.boolean().describe("Debe ser true solo tras confirmación explícita del usuario") });

function toolResult(data: unknown): string { return JSON.stringify({ ok: true, data }); }
function toolError(error: unknown): string { return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Error inesperado" }); }
function fixtures(ctx: ToolContext): string { return ctx.directory; }
function caseDir(ctx: ToolContext, caso: string): string { return join(fixtures(ctx), "casos", caso); }
function outputDir(ctx: ToolContext, caso: string): string { return join(ctx.directory, "out", caso); }

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
function atPath(value: Record<string, unknown>, path: string): unknown { return path.split(".").reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value); }
function fmt(value: unknown): string { return typeof value === "number" ? new Intl.NumberFormat("es-CO").format(value) : String(value); }
function isForeignTaxId(label: string, pais: string): boolean { return ["RUC", "RTN", "Identificación tributaria", "Número de identificación fiscal"].includes(label) && pais !== "CO"; }

async function solicitar(ctx: ToolContext, caso: string): Promise<{ pais: string; cliente: string; formato: Formato; campos: Solicitado[]; soportes: string[] }> {
  const base = caseDir(ctx, caso);
  const request = await json<{ pais: string; cliente: string; formato: Formato }>(join(base, "solicitud.json"));
  const template = request.formato === "xlsx"
    ? await json<Solicitado[]>(join(base, "plantilla-celdas.json"))
    : await json<Solicitado[]>(join(base, "plantilla-campos.json"));
  const supports = await json<string[]>(join(base, "soportes-exigidos.json"));
  return { pais: request.pais, cliente: request.cliente, formato: request.formato, campos: template, soportes: supports };
}

async function mapear(ctx: ToolContext, caso: string, fields: string[]): Promise<Mapeo> {
  const info = await solicitar(ctx, caso);
  const master = await json<Record<string, unknown>>(join(fixtures(ctx), "repositorio", "maestro.json"));
  const glossary = await json<Record<string, string>>(join(fixtures(ctx), "glosario-campos.json"));
  const items = fields.map((etiqueta): MapeoItem => {
    const ruta = glossary[etiqueta];
    const value = ruta ? atPath(master, ruta) : undefined;
    if (value === undefined || value === null || value === "") return { etiqueta, estado: "faltante", confianza: 0 };
    if (isForeignTaxId(etiqueta, info.pais)) return { etiqueta, estado: "requiere_confirmacion", ruta, valor: value as string | number | boolean, nota: "identificador extranjero: verificar equivalencia para el país del cliente", confianza: 0.75 };
    return { etiqueta, estado: "lleno", ruta, valor: value as string | number | boolean, confianza: 1 };
  });
  return { llenos: items.filter((item) => item.estado === "lleno"), faltantes: items.filter((item) => item.estado === "faltante"), requiere_confirmacion: items.filter((item) => item.estado === "requiere_confirmacion") };
}

async function log(ctx: ToolContext, caso: string, herramienta: string, ok: boolean, resumen: string): Promise<void> {
  const target = join(outputDir(ctx, caso), "log.jsonl");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ ts: new Date().toISOString(), herramienta, ok, resumen })}\n`, { flag: "a" });
}

async function formData(ctx: ToolContext, caso: string): Promise<{ info: Awaited<ReturnType<typeof solicitar>>; mapeo: Mapeo; byLabel: Map<string, MapeoItem> }> {
  const info = await solicitar(ctx, caso);
  const mapeo = await mapear(ctx, caso, info.campos.map((field) => field.etiqueta));
  return { info, mapeo, byLabel: new Map([...mapeo.llenos, ...mapeo.faltantes, ...mapeo.requiere_confirmacion].map((item) => [item.etiqueta, item])) };
}

async function generateExcel(ctx: ToolContext, caso: string): Promise<string> {
  const { info, byLabel } = await formData(ctx, caso);
  const workbook = new ExcelJS.Workbook();
  for (const field of info.campos) {
    const sheet = workbook.getWorksheet(field.hoja ?? "Formulario") ?? workbook.addWorksheet(field.hoja ?? "Formulario");
    sheet.getCell(field.celda_etiqueta ?? "A1").value = field.etiqueta;
    const mapping = byLabel.get(field.etiqueta);
    sheet.getCell(field.celda_valor ?? "B1").value = mapping?.valor === undefined ? "PENDIENTE" : fmt(mapping.valor);
  }
  const route = join(outputDir(ctx, caso), "formulario.xlsx");
  await mkdir(dirname(route), { recursive: true });
  await workbook.xlsx.writeFile(route);
  return route;
}

async function generatePdf(ctx: ToolContext, caso: string): Promise<string> {
  const { info, byLabel } = await formData(ctx, caso);
  const route = join(outputDir(ctx, caso), "formulario.pdf");
  await mkdir(dirname(route), { recursive: true });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const document = new PDFDocument({ margin: 54 });
    const file = createWriteStream(route);
    document.pipe(file);
    document.fontSize(18).text("Formulario de registro como proveedor");
    document.moveDown().fontSize(10).fillColor("#475569").text(`Cliente: ${info.cliente} · País: ${info.pais}`);
    document.moveDown();
    for (const field of info.campos) {
      const mapping = byLabel.get(field.etiqueta);
      document.fillColor("#0f172a").fontSize(11).text(field.etiqueta, { continued: true });
      document.fillColor(mapping?.estado === "faltante" ? "#b45309" : "#0f172a").text(`  ${mapping?.valor === undefined ? "PENDIENTE" : fmt(mapping.valor)}`);
      if (mapping?.nota) document.fillColor("#b45309").fontSize(9).text(mapping.nota);
      document.moveDown(0.45);
    }
    document.end();
    file.on("finish", resolvePromise);
    file.on("error", rejectPromise);
  });
  return route;
}

async function generatePortal(ctx: ToolContext, caso: string): Promise<string> {
  const { info, byLabel } = await formData(ctx, caso);
  const rows = info.campos.map((field) => {
    const mapping = byLabel.get(field.etiqueta);
    return `| ${field.etiqueta} | ${mapping?.valor === undefined ? "PENDIENTE" : fmt(mapping.valor)} | ${mapping?.estado ?? "faltante"} |`;
  });
  const route = join(outputDir(ctx, caso), "valores-portal.md");
  await mkdir(dirname(route), { recursive: true });
  await writeFile(route, `# Valores para portal\n\nEl portal no se automatiza. El analista ingresa credenciales y confirma el envío.\n\n| Campo | Valor | Estado |\n|---|---|---|\n${rows.join("\n")}\n`);
  return route;
}

async function packageCase(ctx: ToolContext, caso: string): Promise<{ route: string; ready: boolean; checklist: string[] }> {
  const { info, mapeo } = await formData(ctx, caso);
  const form = info.formato === "xlsx" ? await generateExcel(ctx, caso) : info.formato === "pdf" ? await generatePdf(ctx, caso) : await generatePortal(ctx, caso);
  const target = join(outputDir(ctx, caso), "paquete");
  await mkdir(target, { recursive: true });
  await copyFile(form, join(target, form.split(/[\\/]/).pop() ?? "formulario"));
  const index = await json<Array<{ tipo: string; archivo: string; vigencia_hasta: string | null }>>(join(fixtures(ctx), "repositorio", "soportes", "index.json"));
  const now = new Date().toISOString().slice(0, 10);
  const checklist: string[] = [];
  let blocked = false;
  for (const type of info.soportes) {
    const support = index.find((item) => item.tipo === type);
    if (!support) { checklist.push(`- [ ] ${type}: ausente`); blocked = true; continue; }
    const source = join(fixtures(ctx), "repositorio", "soportes", support.archivo);
    if (!(await exists(source))) { checklist.push(`- [ ] ${type}: archivo ausente`); blocked = true; continue; }
    await copyFile(source, join(target, support.archivo));
    if (support.vigencia_hasta && support.vigencia_hasta < now) { checklist.push(`- [ ] ${type}: vencido (${support.vigencia_hasta})`); blocked = true; }
    else checklist.push(`- [x] ${type}: presente${support.vigencia_hasta ? `, vigente hasta ${support.vigencia_hasta}` : ""}`);
  }
  const pending = [...mapeo.faltantes, ...mapeo.requiere_confirmacion];
  if (pending.length) { checklist.push(`\n## Campos a revisar\n${pending.map((item) => `- ${item.etiqueta}: ${item.estado}`).join("\n")}`); blocked = true; }
  await writeFile(join(target, "checklist.md"), `# Checklist de firma\n\n${checklist.join("\n")}\n`);
  await writeFile(join(target, "borrador-correo.md"), `Asunto: Documentación para registro como proveedor – ${info.cliente}\n\nHola,\n\nAdjuntamos el formulario diligenciado y los soportes solicitados para el registro de Periferia IT Group S.A.S. Quedamos atentos a cualquier información adicional.\n\nCordialmente,\nÁrea Administrativa\n`);
  return { route: target, ready: !blocked, checklist };
}

export const leer_solicitud = { description: "Lee la solicitud, plantilla y soportes exigidos de un caso.", args: { caso: argsCaso.shape.caso }, async execute(args: { caso: string }, ctx: ToolContext): Promise<string> { try { const data = await solicitar(ctx, args.caso); await log(ctx, args.caso, "proveedor_leer_solicitud", true, `${data.campos.length} campos detectados`); return toolResult({ ...data, campos: data.campos.map((field) => field.etiqueta) }); } catch (error) { return toolError(error); } } };
export const mapear_campos = { description: "Cruza etiquetas solicitadas contra el maestro y reporta trazabilidad, faltantes y confirmaciones.", args: { caso: argsMapeo.shape.caso, campos: argsMapeo.shape.campos }, async execute(args: { caso: string; campos: string[] }, ctx: ToolContext): Promise<string> { try { const data = await mapear(ctx, args.caso, args.campos); await log(ctx, args.caso, "proveedor_mapear_campos", true, `${data.llenos.length} llenos, ${data.faltantes.length} faltantes`); return toolResult(data); } catch (error) { return toolError(error); } } };
export const generar_formulario = { description: "Genera el formulario Excel, PDF o valores copiable para portal de un caso.", args: { caso: argsFormulario.shape.caso, mapeo: argsFormulario.shape.mapeo }, async execute(args: { caso: string; mapeo: unknown }, ctx: ToolContext): Promise<string> { try { const info = await solicitar(ctx, args.caso); const ruta = info.formato === "xlsx" ? await generateExcel(ctx, args.caso) : info.formato === "pdf" ? await generatePdf(ctx, args.caso) : await generatePortal(ctx, args.caso); await log(ctx, args.caso, "proveedor_generar_formulario", true, ruta); return toolResult({ ruta, formato: info.formato, mensaje: info.formato === "portal" ? "formato no soportado; se generaron valores para copiar" : undefined }); } catch (error) { return toolError(error); } } };
export const armar_paquete = { description: "Arma el paquete de firma con formulario, soportes, checklist y borrador de correo.", args: { caso: argsCaso.shape.caso }, async execute(args: { caso: string }, ctx: ToolContext): Promise<string> { try { const data = await packageCase(ctx, args.caso); await log(ctx, args.caso, "proveedor_armar_paquete", true, data.ready ? "listo para firma" : "bloqueado por soportes"); return toolResult({ ruta: data.route, listo_para_firma: data.ready, checklist: data.checklist }); } catch (error) { return toolError(error); } } };
export const simular_envio = { description: "Escribe un envío simulado solo con confirmación explícita del usuario.", args: { caso: argsEnvio.shape.caso, confirmado: argsEnvio.shape.confirmado }, async execute(args: { caso: string; confirmado: boolean }, ctx: ToolContext): Promise<string> { try { if (!args.confirmado) return JSON.stringify({ ok: false, error: "requiere confirmación explícita" }); const route = join(outputDir(ctx, args.caso), "ENVIO-SIMULADO.md"); await mkdir(dirname(route), { recursive: true }); await writeFile(route, `# Envío simulado\n\nCaso: ${args.caso}\nFecha: ${new Date().toISOString()}\n\nNo se envió ningún correo real.\n`); await log(ctx, args.caso, "proveedor_simular_envio", true, "envío simulado creado"); return toolResult({ ruta: route }); } catch (error) { return toolError(error); } } };

export const proveedorTools = { leer_solicitud, mapear_campos, generar_formulario, armar_paquete, simular_envio };
export async function limpiarSalidas(directory: string): Promise<void> { await rm(resolve(directory, "out"), { recursive: true, force: true }); }
