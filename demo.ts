import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { armar_paquete, generar_formulario, leer_solicitud, limpiarSalidas, mapear_campos } from "./src/tools/proveedor.js";

const directory = resolve(dirname(fileURLToPath(import.meta.url)));
const casesDirectory = resolve(directory, "casos");

await limpiarSalidas(directory);
for (const caso of await readdir(casesDirectory)) {
  const ctx = { directory, sessionId: "demo" };
  const request = JSON.parse(await leer_solicitud.execute({ caso }, ctx)) as { ok: boolean; data: { campos: string[] } };
  if (!request.ok) throw new Error(`No se pudo leer ${caso}`);
  const mapping = JSON.parse(await mapear_campos.execute({ caso, campos: request.data.campos }, ctx));
  const form = JSON.parse(await generar_formulario.execute({ caso, mapeo: mapping.data }, ctx));
  const packageResult = JSON.parse(await armar_paquete.execute({ caso }, ctx));
  console.log(`${caso}: ${form.data.formato} · firma=${packageResult.data.listo_para_firma} · ${packageResult.data.ruta}`);
}
