# Agente de registro como proveedor

Aplicación local en .NET 8 que prepara formularios de registro de proveedores, soportes y borradores de correo desde los fixtures suministrados. No firma, no envía correos reales ni automatiza portales.

## Requisitos

- .NET SDK 8 o superior.
- No requiere Node.js, npm, API key ni conexión a un modelo de lenguaje para la demostración.

## Inicio

Desde la carpeta `reto-01`:

```powershell
dotnet run --project RegistroProveedor.csproj
```

Abre la URL que indica la consola, normalmente `http://localhost:5000`. Si deseas un puerto fijo:

```powershell
dotnet run --project RegistroProveedor.csproj --urls http://127.0.0.1:5099
```

## Prueba funcional

1. Escribe `Procesa el caso co-industrias-delta`.
2. Revisa los campos, soportes y llamadas de herramientas mostradas.
3. Responde `confirmo` para generar únicamente `ENVIO-SIMULADO.md`.
4. Repite con los cuatro casos disponibles:
   - `co-industrias-delta`: formulario Excel colombiano.
   - `ec-corp-andina`: formulario PDF ecuatoriano y RUC para confirmar.
   - `hn-agroexport-sula`: formulario Excel para proveedor extranjero.
   - `pa-logistica-istmo`: portal no soportado; genera valores copiable.

Los resultados se escriben en `out/<caso>/` y no se modifican los fixtures.

## Verificación

```powershell
dotnet build RegistroProveedor.csproj
```

La validación realizada cubrió compilación exitosa, procesamiento de los cuatro casos, generación de XLSX/PDF/Markdown, paquete de firma y envío simulado con confirmación.

## API

- `POST /api/chat`: `{ "sessionId": "...", "message": "Procesa el caso ec-corp-andina" }`
- `GET /api/sessions/:id`: historial de la sesión actual.
- `GET /api/health`: estado de la aplicación.

## Archivos principales

- `Program.cs`: backend, ciclo determinista, mapeo, archivos y API.
- `web/index.html`: interfaz de chat y visualización de herramientas.
- `casos/`: solicitudes y plantillas de entrada.
- `repositorio/` y `glosario-campos.json`: datos maestros y soportes.
- `SOLUCION.md`: arquitectura, decisiones y alcance.

## Entrega

No se creó un enlace público desde este entorno. La aplicación está lista para demostrarse localmente con .NET 8.
