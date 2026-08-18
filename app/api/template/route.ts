type IRBlock = {
  type: string;
  text?: string;
  level?: number;
  listType?: "ordered" | "unordered";
  table?: { cells: Array<Array<{ text: string }>> };
};

type ParseResult =
  | { success: true; markdown: string; blocks: IRBlock[]; metadata?: unknown; outline?: unknown[]; warnings?: unknown[] }
  | { success: false; error: string; code?: string };

type KordocModule = { parse: (input: Buffer, options?: Record<string, unknown>) => Promise<ParseResult> };


export const runtime = "nodejs";
export const maxDuration = 120;

const SUPPORTED_EXTENSIONS = new Set(["hwp", "hwpx", "docx", "pdf", "xlsx", "xls"]);
const MAX_FILE_SIZE = 25 * 1024 * 1024;

function extensionOf(fileName: string): string {
  return fileName.toLowerCase().split(".").pop() ?? "";
}

function blockText(block: IRBlock): string {
  if (block.type === "table" && block.table) {
    return block.table.cells.map((row) => row.map((cell) => cell.text.trim()).join(" | ")).join("\n");
  }
  return block.text?.trim() ?? "";
}

function structureSummary(blocks: IRBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const text = blockText(block);
    if (!text && block.type !== "separator") continue;
    if (block.type === "heading") lines.push(`${"#".repeat(Math.min(Math.max(block.level ?? 2, 1), 6))} ${text}`);
    else if (block.type === "table") lines.push(`표\n${text}`);
    else if (block.type === "list") lines.push(`${block.listType === "ordered" ? "1." : "-"} ${text}`);
    else if (block.type === "separator") lines.push("---");
    else lines.push(text);
  }
  return lines.join("\n\n").trim();
}

function normalizeMarkdown(markdown: string, blocks: IRBlock[]): string {
  const structured = structureSummary(blocks);
  const result = structured || markdown.trim();
  return result.replace(/\n{3,}/g, "\n\n").slice(0, 30000);
}

async function analyzeDocument(buffer: Buffer, fileName: string): Promise<ParseResult> {
  // kordoc supports HWP3/HWP5, HWPX, DOCX, PDF, XLSX and XLS directly.
  // Keep this route on Node.js: kordoc uses Node-compatible binary parsers.
  try {
    const kordocModuleName = "kordoc";
    const { parse } = await import(/* @vite-ignore */ kordocModuleName) as KordocModule;
    return await parse(buffer, {
      tables: true,
      keepEmptyParagraphs: true,
      keepTrailingEmptyCols: true,
      dedupeRunningHeaders: true,
    });
  } catch (nativeError: unknown) {
    // The local vinext preview runs inside a Worker-compatible runner where
    // external Node packages cannot be resolved by import(). Retry through the
    // kordoc CLI only after the direct Node package path has failed.
    const tempPath = path.join(os.tmpdir(), `kordoc-${randomUUID()}-${path.basename(fileName)}`);
    await writeFile(tempPath, buffer);
    try {
      const cliPath = path.join(process.cwd(), "node_modules", "kordoc", "dist", "cli.js");
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cliPath, "--format", "json", "--keep-empty-paragraphs", "--keep-empty-cols", "--dedupe-headers", "--silent", tempPath], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim() || `kordoc CLI 종료 코드 ${code}`)));
      });
      return JSON.parse(result.stdout) as ParseResult;
    } catch (cliError: unknown) {
      const directMessage = nativeError instanceof Error ? nativeError.message : "라이브러리 파서 오류";
      const cliMessage = cliError instanceof Error ? cliError.message : "CLI 파서 오류";
      throw new Error(`kordoc 직접 분석 실패: ${directMessage}; CLI 재시도 실패: ${cliMessage}`);
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ status: "error", code: "INVALID_MULTIPART", error: "업로드 요청을 읽을 수 없습니다." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json({ status: "error", code: "FILE_REQUIRED", error: "분석할 파일을 선택해 주세요." }, { status: 400 });
  }

  const extension = extensionOf(file.name);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return Response.json({
      fileName: file.name,
      extension,
      status: "error",
      code: "UNSUPPORTED_FILE_TYPE",
      error: `지원하지 않는 파일 형식입니다: .${extension || "확장자 없음"}. HWP, HWPX, DOCX, PDF, XLSX, XLS만 지원합니다.`,
    }, { status: 415 });
  }
  if (file.size === 0) {
    return Response.json({ fileName: file.name, extension, status: "error", code: "EMPTY_FILE", error: "빈 파일은 분석할 수 없습니다." }, { status: 422 });
  }
  if (file.size > MAX_FILE_SIZE) {
    return Response.json({ fileName: file.name, extension, status: "error", code: "FILE_TOO_LARGE", error: "파일 크기는 25MB 이하이어야 합니다." }, { status: 413 });
  }

  try {
    const parsed = await analyzeDocument(Buffer.from(await file.arrayBuffer()), file.name);
    if (!parsed.success) {
      return Response.json({ fileName: file.name, extension, status: "error", code: parsed.code ?? "PARSE_ERROR", error: `.${extension.toUpperCase()} 분석 실패: ${parsed.error}` }, { status: 422 });
    }

    const markdown = normalizeMarkdown(parsed.markdown, parsed.blocks);
    if (!markdown) {
      return Response.json({ fileName: file.name, extension, status: "error", code: "EMPTY_ANALYSIS", error: `.${extension.toUpperCase()} 파일에서 문서 내용을 찾지 못했습니다.` }, { status: 422 });
    }

    return Response.json({
      fileName: file.name,
      extension,
      status: "completed",
      markdown,
      metadata: parsed.metadata ?? {},
      outline: parsed.outline ?? [],
      warnings: parsed.warnings ?? [],
      blockCount: parsed.blocks.length,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "알 수 없는 오류";
    return Response.json({ fileName: file.name, extension, status: "error", code: "PARSE_EXCEPTION", error: `.${extension.toUpperCase()} 분석 실패: ${reason}` }, { status: 422 });
  }
}
import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
