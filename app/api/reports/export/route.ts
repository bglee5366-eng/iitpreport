import JSZip from "jszip";
import fontDataUrl from "./NotoSansKR-VF.ttf?inline";
import templateDataUrl from "./report-template.hwpx?inline";
import { createRequire } from "node:module";

// PDFKit is CommonJS and expects Node's module globals. Keep it external and
// load it through Node's require instead of bundling it into an ESM handler.
const PDFDocument = createRequire(import.meta.url)("pdfkit") as typeof import("pdfkit").default;

export const runtime = "nodejs";

type ReportSource = { title: string; url: string };
type ProviderResult = { status: string; text?: string; sources?: ReportSource[]; warning?: string };
type ExportReport = {
  title: string;
  query: string;
  period: string;
  templateFileName?: string;
  templateMarkdown?: string;
  results: { openai: ProviderResult; gemini: ProviderResult; claude: ProviderResult };
};

function bundledAsset(value: string, label: string): Buffer {
  if (!value.startsWith("data:")) throw new Error(`${label}가 빌드 결과에 포함되지 않았습니다.`);
  const separator = value.indexOf(",");
  if (separator < 0) throw new Error(`${label} 데이터 형식이 올바르지 않습니다.`);
  return Buffer.from(value.slice(separator + 1), "base64");
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function reportText(report: ExportReport): string {
  const result = [report.results.gemini, report.results.openai, report.results.claude].find((item) => item.status === "success" && item.text);
  return result?.text ?? "보고서 본문이 없습니다.";
}

function templateHeadings(report: ExportReport): string[] {
  // The current saved report stores the analyzed template name, while the
  // generated body preserves its extracted headings and order.
  const headings = report.templateMarkdown?.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line)).map((line) => line.replace(/^#+\s+/, "").trim()) ?? [];
  return [...(report.templateFileName ? [`적용 양식: ${report.templateFileName}`] : []), ...headings];
}

function linesFor(report: ExportReport): string[] {
  const body = reportText(report).replace(/\r/g, "").replace(/\\n/g, "\n").replace(/\[출처 확인 필요\]/g, "(출처 확인 필요)");
  return [report.title, ...templateHeadings(report), `분석 이슈: ${report.query}`, `검색 기간: ${report.period}`, "", ...body.split("\n")].map((line) => line.trimEnd());
}

function docxParagraph(text: string, heading = false): string {
  const size = heading ? 30 : 22;
  const bold = heading ? "<w:b/>" : "";
  return `<w:p><w:pPr>${heading ? `<w:keepNext/><w:spacing w:before="180" w:after="80"/>` : `<w:spacing w:after="100"/>`}</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Malgun Gothic"/><w:sz w:val="${size}"/>${bold}</w:rPr><w:t xml:space="preserve">${xml(text || " ")}</w:t></w:r></w:p>`;
}

async function createDocx(report: ExportReport): Promise<Buffer> {
  const zip = new JSZip();
  const lines = linesFor(report);
  const body = lines.map((line, index) => docxParagraph(line, index === 0 || /^\s*(현황|문제점|대응방향|향후계획|참고 출처|핵심 요약|시사점|효과성|실행계획)/.test(line))).join("");
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Malgun Gothic"/><w:lang w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

async function createHwpx(report: ExportReport): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bundledAsset(templateDataUrl, "HWPX 기본 문서 템플릿"));
  const sectionFile = zip.file("Contents/section0.xml");
  if (!sectionFile) throw new Error("HWPX 기본 문서의 본문 영역을 찾을 수 없습니다.");
  const section = await sectionFile.async("string");
  const lines = linesFor(report);
  const firstParagraph = section.match(/<hp:p\b[\s\S]*?<\/hp:p>/)?.[0];
  if (!firstParagraph) throw new Error("HWPX 본문 문단 구조를 읽을 수 없습니다.");
  const titleParagraph = firstParagraph.replace("<hp:t/>", `<hp:t>${xml(lines[0] ?? report.title)}</hp:t>`);
  const paragraphs = lines.slice(1).map((line, index) => `<hp:p id="${Date.now() + index}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${xml(line || " ")}</hp:t></hp:run></hp:p>`).join("");
  zip.file("Contents/section0.xml", section.replace(firstParagraph, `${titleParagraph}${paragraphs}`));
  zip.file("Preview/PrvText.txt", lines.join("\n"));
  return zip.generateAsync({ type: "nodebuffer", mimeType: "application/hwp+zip", compression: "DEFLATE" });
}

function createPdf(report: ExportReport): Promise<Buffer> {
  const fontBuffer = bundledAsset(fontDataUrl, "PDF용 한글 글꼴 파일");
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    document.font(fontBuffer);
    linesFor(report).forEach((line, index) => {
      const heading = index === 0 || /^\s*(현황|문제점|대응방향|향후계획|참고 출처|핵심 요약|시사점|효과성|실행계획)/.test(line);
      document.fontSize(index === 0 ? 18 : heading ? 13 : 10).text(line || " ", { paragraphGap: heading ? 5 : 2, lineGap: 2 });
    });
    document.end();
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { format?: string; report?: ExportReport };
    const format = body.format?.toLowerCase();
    if (!body.report || !["docx", "hwpx", "pdf"].includes(format ?? "")) return Response.json({ error: "지원 형식은 DOCX, HWPX, PDF입니다." }, { status: 400 });
    const report = body.report;
    const base = report.title.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "issue-report";
    if (format === "docx") return new Response(new Uint8Array(await createDocx(report)), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.docx`)}` } });
    if (format === "hwpx") return new Response(new Uint8Array(await createHwpx(report)), { headers: { "Content-Type": "application/hwp+zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.hwpx`)}` } });
    return new Response(new Uint8Array(await createPdf(report)), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.pdf`)}` } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "문서 생성에 실패했습니다." }, { status: 500 });
  }
}
