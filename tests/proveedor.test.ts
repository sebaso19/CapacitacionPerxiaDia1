import { beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { armar_paquete, leer_solicitud, limpiarSalidas, mapear_campos } from "../src/tools/proveedor.js";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = { directory, sessionId: "test" };

beforeEach(async () => { await limpiarSalidas(directory); });

describe("herramientas de proveedor", () => {
  it("lee y mapea un caso colombiano", async () => {
    const request = JSON.parse(await leer_solicitud.execute({ caso: "co-industrias-delta" }, ctx));
    expect(request.ok).toBe(true);
    expect(request.data.formato).toBe("xlsx");
    const mapped = JSON.parse(await mapear_campos.execute({ caso: "co-industrias-delta", campos: request.data.campos }, ctx));
    expect(mapped.data.llenos.some((item: { etiqueta: string }) => item.etiqueta === "NIT")).toBe(true);
  });

  it("requiere confirmación para el identificador extranjero", async () => {
    const mapped = JSON.parse(await mapear_campos.execute({ caso: "ec-corp-andina", campos: ["RUC"] }, ctx));
    expect(mapped.data.requiere_confirmacion[0].etiqueta).toBe("RUC");
  });

  it("bloquea el paquete cuando falta un soporte", async () => {
    const packaged = JSON.parse(await armar_paquete.execute({ caso: "ec-corp-andina" }, ctx));
    expect(packaged.data.listo_para_firma).toBe(false);
  });

  it("bloquea el paquete cuando queda un campo sin resolver", async () => {
    const packaged = JSON.parse(await armar_paquete.execute({ caso: "hn-agroexport-sula" }, ctx));
    expect(packaged.data.listo_para_firma).toBe(false);
  });
});
