import JSZip from "jszip";
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";

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
  const zip = new JSZip();
  const paragraphs = linesFor(report).map((line) => `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run><hp:t>${xml(line || " ")}</hp:t></hp:run></hp:p>`).join("");
  zip.file("mimetype", "application/hwp+zip");
  zip.file("version.xml", `<?xml version="1.0" encoding="UTF-8"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="1" os="1" xmlVersion="1.2" application="Hancom Office Hangul" appVersion="11, 0, 0, 2129 WIN32LEWindows_8"/>`);
  zip.file("settings.xml", `<?xml version="1.0" encoding="UTF-8"?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`);
  zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/><ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></ocf:rootfiles></ocf:container>`);
  zip.file("META-INF/container.rdf", `<?xml version="1.0" encoding="UTF-8"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>`);
  zip.file("META-INF/manifest.xml", `<?xml version="1.0" encoding="UTF-8"?><odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`);
  zip.file("Preview/PrvText.txt", report.title);
  zip.file("Contents/content.hpf", `<?xml version="1.0" encoding="UTF-8"?><opf:package xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:opf="http://www.idpf.org/2007/opf/" version="1.0" unique-identifier="document" id="document"><opf:metadata><opf:title>${xml(report.title)}</opf:title><opf:language>ko</opf:language></opf:metadata><opf:manifest><opf:item id="section0" href="section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="section0"/></opf:spine></opf:package>`);
  zip.file("Contents/header.xml", `<?xml version="1.0" encoding="UTF-8"?><hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.4" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" /><hh:compatibleDocument targetProgram="HWP" targetVersion="50304"/></hh:head>`);
  zip.file("Contents/section0.xml", `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"><hs:p><hp:run><hp:t>${xml(report.title)}</hp:t></hp:run></hs:p>${paragraphs}</hs:sec>`);
  return zip.generateAsync({ type: "nodebuffer", mimeType: "application/hwp+zip", compression: "DEFLATE" });
}

function createPdf(report: ExportReport): Promise<Buffer> {
  const fontPath = path.join(process.cwd(), "public", "fonts", "NotoSansKR-VF.ttf");
  if (!fs.existsSync(fontPath)) throw new Error("PDF용 한글 글꼴 파일을 찾을 수 없습니다.");
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    document.font(fontPath);
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
