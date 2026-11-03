using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.FileProviders;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
var root = app.Environment.ContentRootPath;
var sessions = new Dictionary<string, Session>();
var jsonOptions = new JsonSerializerOptions { WriteIndented = true };

app.MapGet("/api/health", () => Results.Json(new { ok = true, provider = "deterministic-dotnet", model = "no requiere modelo" }));
app.MapGet("/api/sessions/{id}", (string id) => Results.Json(sessions.TryGetValue(id, out var session) ? session : new Session()));
app.MapPost("/api/chat", async (ChatRequest request) =>
{
    if (string.IsNullOrWhiteSpace(request.SessionId) || string.IsNullOrWhiteSpace(request.Message)) return Results.BadRequest(new { error = "sessionId y message son obligatorios" });
    var session = sessions.TryGetValue(request.SessionId, out var existing) ? existing : new Session();
    var reply = await ProcessChat(root, request.Message, session, jsonOptions);
    sessions[request.SessionId] = session;
    return Results.Json(reply);
});

app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = new PhysicalFileProvider(Path.Combine(root, "web")) });
app.UseStaticFiles(new StaticFileOptions { FileProvider = new PhysicalFileProvider(Path.Combine(root, "web")) });
app.Run();

static async Task<ChatResponse> ProcessChat(string root, string message, Session session, JsonSerializerOptions options)
{
    var calls = new List<ToolCall>();
    var knownCases = new[] { "co-industrias-delta", "ec-corp-andina", "hn-agroexport-sula", "pa-logistica-istmo" };
    var caseName = knownCases.FirstOrDefault(item => message.Contains(item, StringComparison.OrdinalIgnoreCase));
    if (session.PendingConfirmation is not null && IsConfirmed(message))
    {
        var path = Path.Combine(root, "out", session.PendingConfirmation, "ENVIO-SIMULADO.md");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, $"# Envío simulado\n\nCaso: {session.PendingConfirmation}\nFecha: {DateTimeOffset.UtcNow:O}\n\nNo se envió ningún correo real.\n");
        calls.Add(new ToolCall("proveedor_simular_envio", new { caso = session.PendingConfirmation, confirmado = true }, true, path));
        await LogAsync(root, session.PendingConfirmation, "proveedor_simular_envio", true, "envío simulado creado");
        var sent = session.PendingConfirmation;
        session.PendingConfirmation = null;
        session.History.Add(new History("user", message));
        session.History.Add(new History("assistant", "Se creó el envío simulado."));
        return new ChatResponse($"Se generó el envío simulado para {sent}. No se envió ningún correo real.", calls, false);
    }
    if (caseName is null) return new ChatResponse("Indica un caso para procesar: co-industrias-delta, ec-corp-andina, hn-agroexport-sula o pa-logistica-istmo.", calls, false);

    try
    {
        var casePath = Path.Combine(root, "casos", caseName);
        var solicitud = await ReadJsonAsync(Path.Combine(casePath, "solicitud.json"));
        if (solicitud is null) throw new InvalidOperationException("Solicitud inválida");
        var formato = solicitud["formato"]!.GetValue<string>();
        var pais = solicitud["pais"]!.GetValue<string>();
        var cliente = solicitud["cliente"]!.GetValue<string>();
        var templateName = formato == "xlsx" ? "plantilla-celdas.json" : "plantilla-campos.json";
        var fields = await ReadJsonAsync(Path.Combine(casePath, templateName));
        var supportTypes = await ReadJsonAsync(Path.Combine(casePath, "soportes-exigidos.json"));
        calls.Add(new ToolCall("proveedor_leer_solicitud", new { caso = caseName }, true, $"{fields!.AsArray().Count} campos detectados"));
        await LogAsync(root, caseName, "proveedor_leer_solicitud", true, $"{fields!.AsArray().Count} campos detectados");

        var master = await ReadJsonAsync(Path.Combine(root, "repositorio", "maestro.json"));
        var glossary = await ReadJsonAsync(Path.Combine(root, "glosario-campos.json"));
        var mapped = MapFields(fields!.AsArray(), master!, glossary!, pais);
        calls.Add(new ToolCall("proveedor_mapear_campos", new { caso = caseName }, true, $"{mapped.Filled.Count} llenos, {mapped.Missing.Count} faltantes, {mapped.Confirmation.Count} por confirmar"));
        await LogAsync(root, caseName, "proveedor_mapear_campos", true, $"{mapped.Filled.Count} llenos, {mapped.Missing.Count} faltantes");

        var outPath = Path.Combine(root, "out", caseName);
        Directory.CreateDirectory(outPath);
        var formResult = await GenerateFormAsync(formato, outPath, fields.AsArray(), mapped, cliente, pais);
        calls.Add(new ToolCall("proveedor_generar_formulario", new { caso = caseName, formato }, true, formResult.Path));
        await LogAsync(root, caseName, "proveedor_generar_formulario", true, formResult.Path);

        var packageResult = await BuildPackageAsync(root, outPath, formResult.Path, supportTypes!.AsArray(), mapped, cliente, options);
        calls.Add(new ToolCall("proveedor_armar_paquete", new { caso = caseName }, true, packageResult.Path));
        await LogAsync(root, caseName, "proveedor_armar_paquete", true, packageResult.Ready ? "listo para firma" : "bloqueado por soportes");
        session.PendingConfirmation = caseName;
        session.History.Add(new History("user", message));
        session.History.Add(new History("assistant", "Caso procesado."));
        var missing = mapped.Missing.Select(item => item.Label).ToArray();
        var confirmations = mapped.Confirmation.Select(item => item.Label).ToArray();
        var formatNotice = formResult.Unsupported ? " Formato no soportado: se generaron valores listos para copiar en el portal." : "";
        return new ChatResponse($"Procesé {caseName}.{formatNotice} Formulario y paquete creados en {packageResult.Path}. {(missing.Length > 0 ? $"Faltantes: {string.Join(", ", missing)}." : "No hay campos faltantes.")} {(confirmations.Length > 0 ? $"Requieren confirmación: {string.Join(", ", confirmations)}." : "")} Estado para firma: {(packageResult.Ready ? "listo" : "bloqueado por soportes")}. ¿Confirmas que deseas crear el envío simulado?", calls, true);
    }
    catch (Exception ex)
    {
        return new ChatResponse($"No fue posible procesar el caso: {ex.Message}", calls, false);
    }
}

static bool IsConfirmed(string message) => new[] { "sí", "si", "confirmo", "confirmado", "envía", "enviar", "procede", "adelante" }.Any(value => message.TrimStart().StartsWith(value, StringComparison.OrdinalIgnoreCase));
static async Task<JsonNode?> ReadJsonAsync(string path) => JsonNode.Parse(await File.ReadAllTextAsync(path));
static string? ValueAt(JsonNode node, string path) { foreach (var part in path.Split('.')) node = node?[part] ?? null!; return node?.ToString(); }
static MappedFields MapFields(JsonArray fields, JsonNode master, JsonNode glossary, string country)
{
    var result = new MappedFields();
    foreach (var field in fields)
    {
        var label = field!["etiqueta"]!.GetValue<string>();
        var route = glossary[label]?.GetValue<string>();
        var value = route is null ? null : ValueAt(master, route);
        if (string.IsNullOrWhiteSpace(value)) result.Missing.Add(new MappedItem(label, "faltante", null, null));
        else if (country != "CO" && new[] { "RUC", "RTN", "Identificación tributaria", "Número de identificación fiscal" }.Contains(label)) result.Confirmation.Add(new MappedItem(label, "requiere_confirmacion", value, "identificador extranjero: verificar equivalencia para el país del cliente"));
        else result.Filled.Add(new MappedItem(label, "lleno", value, null));
    }
    return result;
}
static async Task<FormResult> GenerateFormAsync(string format, string output, JsonArray fields, MappedFields mapped, string client, string country)
{
    var all = mapped.All.ToDictionary(item => item.Label, item => item);
    if (format == "portal")
    {
        var portalPath = Path.Combine(output, "valores-portal.md");
        var rows = string.Join("\n", fields.Select(field => { var label = field!["etiqueta"]!.GetValue<string>(); var item = all[label]; return $"| {label} | {item.Value ?? "PENDIENTE"} | {item.Status} |"; }));
        await File.WriteAllTextAsync(portalPath, $"# Valores para portal\n\nEl portal no se automatiza. El analista ingresa credenciales y confirma el envío.\n\n| Campo | Valor | Estado |\n|---|---|---|\n{rows}\n");
        return new FormResult(portalPath, true);
    }
    if (format == "xlsx")
    {
        var xlsxPath = Path.Combine(output, "formulario.xlsx");
        CreateXlsx(xlsxPath, fields, all);
        return new FormResult(xlsxPath, false);
    }
    var pdfPath = Path.Combine(output, "formulario.pdf");
    CreatePdf(pdfPath, fields, all, client, country);
    return new FormResult(pdfPath, false);
}
static void CreateXlsx(string path, JsonArray fields, Dictionary<string, MappedItem> values)
{
    var sheets = fields.GroupBy(field => field!["hoja"]!.GetValue<string>()).ToArray();
    if (File.Exists(path)) File.Delete(path);
    using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
    WriteZip(archive, "[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>" + string.Join("", Enumerable.Range(1, sheets.Length).Select(index => $"<Override PartName=\"/xl/worksheets/sheet{index}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>")) + "</Types>");
    WriteZip(archive, "_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>");
    WriteZip(archive, "xl/workbook.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>" + string.Join("", sheets.Select((sheet, index) => $"<sheet name=\"{EscapeXml(sheet.Key)}\" sheetId=\"{index + 1}\" r:id=\"rId{index + 1}\"/>")) + "</sheets></workbook>");
    WriteZip(archive, "xl/_rels/workbook.xml.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" + string.Join("", Enumerable.Range(1, sheets.Length).Select(index => $"<Relationship Id=\"rId{index}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{index}.xml\"/>")) + "</Relationships>");
    foreach (var (sheet, index) in sheets.Select((sheet, index) => (sheet, index + 1)))
    {
        var cells = sheet.SelectMany(field => { var label = field!["etiqueta"]!.GetValue<string>(); var value = values[label].Value ?? "PENDIENTE"; return new[] { (field["celda_etiqueta"]!.GetValue<string>(), label), (field["celda_valor"]!.GetValue<string>(), value) }; });
        WriteZip(archive, $"xl/worksheets/sheet{index}.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData><row r=\"1\">" + string.Join("", cells.Select(cell => $"<c r=\"{cell.Item1}\" t=\"inlineStr\"><is><t>{EscapeXml(cell.Item2)}</t></is></c>")) + "</row></sheetData></worksheet>");
    }
}
static void CreatePdf(string path, JsonArray fields, Dictionary<string, MappedItem> values, string client, string country)
{
    var lines = new List<string> { "Formulario de registro como proveedor", $"Cliente: {client} - País: {country}", "" };
    lines.AddRange(fields.Select(field => { var label = field!["etiqueta"]!.GetValue<string>(); var item = values[label]; return $"{label}: {item.Value ?? "PENDIENTE"}"; }));
    var content = "BT /F1 11 Tf 50 770 Td " + string.Join(" Tj 0 -16 Td ", lines.Select(line => $"({EscapePdf(line)})")) + " Tj ET";
    var objects = new[] { "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", $"<< /Length {Encoding.ASCII.GetByteCount(content)} >>\nstream\n{content}\nendstream", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" };
    using var stream = new FileStream(path, FileMode.Create, FileAccess.Write); using var writer = new StreamWriter(stream, Encoding.ASCII, leaveOpen: true); writer.Write("%PDF-1.4\n"); var offsets = new List<long> { 0 };
    for (var index = 0; index < objects.Length; index++) { writer.Flush(); offsets.Add(stream.Position); writer.Write($"{index + 1} 0 obj\n{objects[index]}\nendobj\n"); }
    writer.Flush(); var xref = stream.Position; writer.Write($"xref\n0 {objects.Length + 1}\n0000000000 65535 f \n" + string.Join("", offsets.Skip(1).Select(offset => $"{offset:0000000000} 00000 n \n")) + $"trailer\n<< /Size {objects.Length + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF");
}
static void WriteZip(ZipArchive archive, string entryName, string content) { using var writer = new StreamWriter(archive.CreateEntry(entryName).Open(), Encoding.UTF8); writer.Write(content); }
static string EscapeXml(string value) => System.Security.SecurityElement.Escape(value) ?? "";
static string EscapePdf(string value) => value.Replace("\\", "\\\\").Replace("(", "\\(").Replace(")", "\\)");
static async Task<PackageResult> BuildPackageAsync(string root, string output, string formPath, JsonArray supportTypes, MappedFields mapped, string client, JsonSerializerOptions options)
{
    var package = Path.Combine(output, "paquete"); Directory.CreateDirectory(package);
    File.Copy(formPath, Path.Combine(package, Path.GetFileName(formPath)), true);
    var index = (await ReadJsonAsync(Path.Combine(root, "repositorio", "soportes", "index.json")))!.AsArray();
    var checklist = new List<string>(); var blocked = false;
    foreach (var node in supportTypes)
    {
        var type = node!.GetValue<string>(); var entry = index.FirstOrDefault(item => item!["tipo"]!.GetValue<string>() == type);
        if (entry is null) { checklist.Add($"- [ ] {type}: ausente"); blocked = true; continue; }
        var file = entry["archivo"]!.GetValue<string>(); var source = Path.Combine(root, "repositorio", "soportes", file);
        if (!File.Exists(source)) { checklist.Add($"- [ ] {type}: archivo ausente"); blocked = true; continue; }
        File.Copy(source, Path.Combine(package, file), true);
        var expires = entry["vigencia_hasta"]?.GetValue<string>();
        if (expires is not null && DateOnly.Parse(expires) < DateOnly.FromDateTime(DateTime.UtcNow)) { checklist.Add($"- [ ] {type}: vencido ({expires})"); blocked = true; } else checklist.Add($"- [x] {type}: presente{(expires is null ? "" : $", vigente hasta {expires}")}");
    }
    if (mapped.Missing.Count + mapped.Confirmation.Count > 0) checklist.Add("\n## Campos a revisar\n" + string.Join("\n", mapped.Missing.Concat(mapped.Confirmation).Select(item => $"- {item.Label}: {item.Status}")));
    await File.WriteAllTextAsync(Path.Combine(package, "checklist.md"), "# Checklist de firma\n\n" + string.Join("\n", checklist));
    await File.WriteAllTextAsync(Path.Combine(package, "borrador-correo.md"), $"Asunto: Documentación para registro como proveedor – {client}\n\nHola,\n\nAdjuntamos el formulario diligenciado y los soportes solicitados para el registro de Periferia IT Group S.A.S. Quedamos atentos a cualquier información adicional.\n\nCordialmente,\nÁrea Administrativa\n");
    return new PackageResult(package, !blocked);
}
static async Task LogAsync(string root, string caseName, string tool, bool ok, string summary)
{
    var directory = Path.Combine(root, "out", caseName); Directory.CreateDirectory(directory);
    await File.AppendAllTextAsync(Path.Combine(directory, "log.jsonl"), JsonSerializer.Serialize(new { ts = DateTimeOffset.UtcNow, herramienta = tool, ok, resumen = summary }) + Environment.NewLine);
}

record ChatRequest(string SessionId, string Message);
record ChatResponse(string Reply, List<ToolCall> ToolCalls, bool NeedsConfirmation);
record ToolCall(string Name, object Args, bool Ok, string Summary);
record History(string Role, string Content);
class Session { public List<History> History { get; } = []; public string? PendingConfirmation { get; set; } }
record MappedItem(string Label, string Status, string? Value, string? Note);
class MappedFields { public List<MappedItem> Filled { get; } = []; public List<MappedItem> Missing { get; } = []; public List<MappedItem> Confirmation { get; } = []; public IEnumerable<MappedItem> All => Filled.Concat(Missing).Concat(Confirmation); }
record PackageResult(string Path, bool Ready);
record FormResult(string Path, bool Unsupported);
