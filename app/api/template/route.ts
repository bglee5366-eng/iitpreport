import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

export const runtime = "nodejs";
export const maxDuration = 120;

const SUPPORTED_EXTENSIONS = new Set(["hwp", "hwpx", "docx", "pdf", "xlsx", "xls"]);
const MAX_FILE_SIZE = 25 * 1024 * 1024;

function extensionOf(fileName: string): string {
  return fileName.toLowerCase().split(".").pop() ?? "";
}

type KordocParser = (input: Buffer, options: Record<string, unknown>) => Promise<any>;

async function parseWithKordoc(buffer: Buffer, fileName: string): Promise<any> {
  try {
    // Keep the optional parser import out of the browser/RSC dependency graph.
    // In a native Node deployment this resolves kordoc directly; the local
    // vinext runner falls through to the structured ZIP/XML parser below.
    const kordocModuleName = "kordoc";
    const { parse } = await import(/* @vite-ignore */ kordocModuleName) as { parse: KordocParser };
    return await parse(buffer, { keepTrailingEmptyCols: true, keepEmptyParagraphs: true, tables: true });
  } catch (nativeError: unknown) {
    const tempPath = path.join(os.tmpdir(), `kordoc-${randomUUID()}-${path.basename(fileName)}`);
    await writeFile(tempPath, buffer);
    try {
      const cliPath = path.join(process.cwd(), "node_modules", "kordoc", "dist", "cli.js");
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cliPath, tempPath, "--format", "json"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim() || `kordoc CLI가 종료 코드 ${code}로 종료되었습니다.`)));
      });
      try { return JSON.parse(result.stdout); } catch { throw new Error("kordoc CLI가 JSON 형식이 아닌 결과를 반환했습니다."); }
    } catch (cliError: unknown) {
      const nativeMessage = nativeError instanceof Error ? nativeError.message : "라이브러리 파서 오류";
      const cliMessage = cliError instanceof Error ? cliError.message : "CLI 파서 오류";
      try {
        return await parseZipDocument(buffer, extensionOf(fileName));
      } catch (fallbackError: unknown) {
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "구조 분석 폴백 오류";
        throw new Error(`kordoc 분석 실패 (라이브러리: ${nativeMessage}; CLI: ${cliMessage}; 구조 폴백: ${fallbackMessage})`);
      }
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

function elementName(node: any): string {
  return String(node?.localName || node?.nodeName || "").split(":").pop() ?? "";
}

function childElements(node: any): any[] {
  return Array.from(node?.childNodes ?? []).filter((child: any) => child.nodeType === 1);
}

function descendantText(node: any, names: Set<string>): string {
  if (!node) return "";
  if (node.nodeType === 3) return String(node.nodeValue ?? "");
  if (node.nodeType !== 1) return "";
  if (names.has(elementName(node))) return Array.from(node.childNodes ?? []).map((child: any) => descendantText(child, names)).join("");
  return Array.from(node.childNodes ?? []).map((child: any) => descendantText(child, names)).join("");
}

function directText(node: any, textTags: Set<string>): string {
  return Array.from(node?.getElementsByTagName?.("*") ?? []).filter((child: any) => textTags.has(elementName(child))).map((child: any) => descendantText(child, textTags)).join("").replace(/\s+/g, " ").trim();
}

function tableToMarkdown(table: any, textTags: Set<string>, rowTag: string, cellTag: string): string {
  const rows = Array.from(table.getElementsByTagName("*")).filter((node: any) => elementName(node) === rowTag);
  const lines = rows.map((row: any) => {
    const cells = childElements(row).filter((node) => elementName(node) === cellTag);
    return `| ${cells.map((cell) => directText(cell, textTags).replace(/\|/g, "\\|")).join(" | ")} |`;
  }).filter((line) => line !== "|  | ");
  if (!lines.length) return "";
  const columnCount = Math.max(1, (lines[0].match(/\|/g) ?? []).length - 1);
  return [lines[0], `| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`, ...lines.slice(1)].join("\n");
}

function documentXmlToMarkdown(xml: string, kind: "hwpx" | "docx"): string {
  const root = new DOMParser().parseFromString(xml, "text/xml");
  const textTags = new Set(kind === "hwpx" ? ["t"] : ["t"]);
  const paragraphTag = kind === "hwpx" ? "p" : "p";
  const tableTag = "tbl";
  const rowTag = kind === "hwpx" ? "tr" : "tr";
  const cellTag = kind === "hwpx" ? "tc" : "tc";
  const blocks: string[] = [];
  const visit = (node: any) => {
    for (const child of childElements(node)) {
      const name = elementName(child);
      if (name === tableTag) {
        const table = tableToMarkdown(child, textTags, rowTag, cellTag);
        if (table) blocks.push(table);
      } else if (name === paragraphTag) {
        const text = directText(child, textTags);
        if (text) blocks.push(text);
      } else if (name !== "tbl") visit(child);
    }
  };
  visit(root.documentElement);
  return blocks.join("\n\n").trim();
}

async function parseZipDocument(buffer: Buffer, extension: string): Promise<any> {
  const zip = await JSZip.loadAsync(buffer);
  if (extension === "hwpx") {
    const sectionNames = Object.keys(zip.files).filter((name) => /^Contents\/section\d+\.xml$/i.test(name)).sort();
    const markdown = (await Promise.all(sectionNames.map(async (name) => documentXmlToMarkdown(await zip.files[name].async("string"), "hwpx")))).filter(Boolean).join("\n\n");
    if (!markdown) throw new Error("HWPX 본문 또는 표 구조를 찾지 못했습니다.");
    return { success: true, fileType: "hwpx", markdown, blocks: [], warnings: [{ code: "RUNTIME_FALLBACK", message: "현재 실행기 호환을 위해 구조 분석 폴백을 사용했습니다." }] };
  }
  if (extension === "docx") {
    const entry = zip.file("word/document.xml");
    if (!entry) throw new Error("DOCX 내부의 word/document.xml을 찾지 못했습니다.");
    const markdown = documentXmlToMarkdown(await entry.async("string"), "docx");
    if (!markdown) throw new Error("DOCX 본문 또는 표 구조를 찾지 못했습니다.");
    return { success: true, fileType: "docx", markdown, blocks: [], warnings: [{ code: "RUNTIME_FALLBACK", message: "현재 실행기 호환을 위해 구조 분석 폴백을 사용했습니다." }] };
  }
  if (extension === "xlsx") {
    const sharedStrings = zip.file("xl/sharedStrings.xml");
    const strings = sharedStrings ? Array.from(new DOMParser().parseFromString(await sharedStrings.async("string"), "text/xml").getElementsByTagName("t")).map((node: any) => String(node.textContent ?? "")) : [];
    const sheetNames = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort();
    const sheets = await Promise.all(sheetNames.map(async (name) => {
      const root = new DOMParser().parseFromString(await zip.files[name].async("string"), "text/xml");
      return Array.from(root.getElementsByTagName("row")).map((row: any) => `| ${Array.from(row.getElementsByTagName("c")).map((cell: any) => { const value = String(cell.getElementsByTagName("v")[0]?.textContent ?? ""); return cell.getAttribute("t") === "s" ? (strings[Number(value)] ?? value) : value; }).join(" | ")} |`).join("\n");
    }));
    const markdown = sheets.filter(Boolean).join("\n\n");
    if (!markdown) throw new Error("XLSX 시트에서 표 구조를 찾지 못했습니다.");
    return { success: true, fileType: "xlsx", markdown, blocks: [], warnings: [{ code: "RUNTIME_FALLBACK", message: "현재 실행기 호환을 위해 구조 분석 폴백을 사용했습니다." }] };
  }
  throw new Error(`.${extension} 파일은 현재 로컬 실행기의 구조 폴백 대상이 아닙니다. Node.js 배포 환경에서 kordoc 파서를 사용해야 합니다.`);
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "업로드 요청을 읽을 수 없습니다." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) return Response.json({ error: "분석할 파일을 선택해주세요." }, { status: 400 });

  const extension = extensionOf(file.name);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return Response.json({ error: `지원하지 않는 파일 형식입니다: .${extension || "확장자 없음"}. HWP, HWPX, DOCX, PDF, XLSX, XLS만 지원합니다.`, code: "UNSUPPORTED_FILE_TYPE" }, { status: 415 });
  }
  if (file.size > MAX_FILE_SIZE) return Response.json({ error: "파일 크기가 25MB를 초과했습니다.", code: "FILE_TOO_LARGE" }, { status: 413 });

  try {
    const parsed = await parseWithKordoc(Buffer.from(await file.arrayBuffer()), file.name);
    if (!parsed.success) {
      return Response.json({ fileName: file.name, extension, status: "error", error: parsed.error, code: parsed.code ?? "PARSE_ERROR" }, { status: 422 });
    }
    return Response.json({ fileName: file.name, extension, status: "completed", markdown: parsed.markdown, metadata: parsed.metadata ?? {}, outline: parsed.outline ?? [], warnings: parsed.warnings ?? [] }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "문서 분석 중 알 수 없는 오류가 발생했습니다.";
    return Response.json({ fileName: file.name, extension, status: "error", error: message, code: "PARSE_EXCEPTION" }, { status: 422 });
  }
}
