import http from "node:http";
import { parse } from "kordoc";

const port = Number(process.env.TEMPLATE_API_PORT ?? 3001);
const supported = new Set(["hwp", "hwpx", "docx", "pdf", "xlsx", "xls"]);
const maxSize = 25 * 1024 * 1024;

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function extensionOf(name) { return name.toLowerCase().split(".").pop() ?? ""; }

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/api/template") {
    json(response, 404, { error: "Not found" });
    return;
  }
  try {
    const webRequest = new Request(`http://127.0.0.1:${port}${request.url}`, {
      method: request.method,
      headers: request.headers,
      body: request,
      duplex: "half",
    });
    const form = await webRequest.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json(response, 400, { status: "error", code: "FILE_REQUIRED", error: "분석할 파일을 선택해 주세요." });
    const extension = extensionOf(file.name);
    if (!supported.has(extension)) return json(response, 415, { fileName: file.name, extension, status: "error", code: "UNSUPPORTED_FILE_TYPE", error: `지원하지 않는 파일 형식입니다: .${extension || "확장자 없음"}. HWP, HWPX, DOCX, PDF, XLSX, XLS만 지원합니다.` });
    if (file.size === 0) return json(response, 422, { fileName: file.name, extension, status: "error", code: "EMPTY_FILE", error: "빈 파일은 분석할 수 없습니다." });
    if (file.size > maxSize) return json(response, 413, { fileName: file.name, extension, status: "error", code: "FILE_TOO_LARGE", error: "파일 크기는 25MB 이하이어야 합니다." });
    const parsed = await parse(Buffer.from(await file.arrayBuffer()), { tables: true, keepEmptyParagraphs: true, keepTrailingEmptyCols: true, dedupeRunningHeaders: true });
    if (!parsed.success) return json(response, 422, { fileName: file.name, extension, status: "error", code: parsed.code ?? "PARSE_ERROR", error: `.${extension.toUpperCase()} 분석 실패: ${parsed.error}` });
    const markdown = parsed.markdown.trim().replace(/\n{3,}/g, "\n\n").slice(0, 30000);
    if (!markdown) return json(response, 422, { fileName: file.name, extension, status: "error", code: "EMPTY_ANALYSIS", error: `.${extension.toUpperCase()} 파일에서 문서 내용을 찾지 못했습니다.` });
    return json(response, 200, { fileName: file.name, extension, status: "completed", markdown, metadata: parsed.metadata ?? {}, outline: parsed.outline ?? [], warnings: parsed.warnings ?? [], blockCount: parsed.blocks.length });
  } catch (error) {
    return json(response, 422, { status: "error", code: "PARSE_EXCEPTION", error: error instanceof Error ? error.message : "문서 분석 중 알 수 없는 오류가 발생했습니다." });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`template API listening on http://127.0.0.1:${port}`));
