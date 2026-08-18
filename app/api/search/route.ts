export const runtime = "nodejs";
export const maxDuration = 120;

const OPENAI_MODEL = "gpt-5.6-luna";
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_SOURCES = 20;

type SearchSource = { title: string; url: string };
type ProviderResult = { status: "success" | "error" | "skipped"; text?: string; sources: SearchSource[]; error?: string; responseMs?: number; model: string };
type SearchInput = { query?: string; reportType?: string; period?: string; sources?: string[]; openAIKey?: string; geminiKey?: string; maxSources?: number; templateFileName?: string; templateMarkdown?: string };

const sourceLabels: Record<string, string> = {
  public: "정부·공공기관(공식 정책·통계·발표)",
  academic: "연구·학술(논문·연구보고서)",
  news: "뉴스(국내외 언론)",
  company: "기업(발표·공시)",
  global: "국제기구(OECD·UN·World Bank 등)",
};

const sourceDomains: Record<string, string[]> = {
  public: ["gov.kr", "korea.kr", "go.kr"],
  academic: ["scholar.google.com", "pubmed.ncbi.nlm.nih.gov", "nature.com", "sciencedirect.com"],
  news: ["reuters.com", "apnews.com", "bbc.com", "yonhapnews.co.kr"],
  company: ["dart.fss.or.kr", "sec.gov"],
  global: ["un.org", "oecd.org", "worldbank.org", "imf.org"],
};

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function normalizeUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || ["fbclid", "gclid"].includes(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return null;
  }
}

function dedupeSources(candidates: SearchSource[], maxSources: number): SearchSource[] {
  const seen = new Set<string>();
  const results: SearchSource[] = [];
  for (const candidate of candidates) {
    const url = normalizeUrl(candidate.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({ title: candidate.title || new URL(url).hostname, url });
    if (results.length >= maxSources) break;
  }
  return results;
}

function textFromOpenAI(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;
  const texts: string[] = [];
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.type === "output_text" && typeof value.text === "string") texts.push(value.text);
    for (const child of Object.values(value)) visit(child);
  };
  visit(response?.output);
  return texts.join("\n\n");
}

function collectOpenAIData(response: any): { sources: SearchSource[]; annotations: any[] } {
  const sources: SearchSource[] = [];
  const annotations: any[] = [];
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.type === "url_citation" && isHttpUrl(value.url)) {
      sources.push({ title: value.title || "OpenAI Web Search 출처", url: value.url });
      annotations.push(value);
    }
    if (value.type === "url" && isHttpUrl(value.url)) sources.push({ title: value.title || "OpenAI Web Search 출처", url: value.url });
    if (value.type === "url_citation" && isHttpUrl(value.uri)) sources.push({ title: value.title || "OpenAI Web Search 출처", url: value.uri });
    for (const child of Object.values(value)) visit(child);
  };
  visit(response);
  return { sources, annotations };
}

function collectGeminiData(response: any): { sources: SearchSource[]; supports: any[] } {
  const grounding = response?.candidates?.[0]?.groundingMetadata;
  const chunks = Array.isArray(grounding?.groundingChunks) ? grounding.groundingChunks : [];
  const sources = chunks.flatMap((chunk: any) => isHttpUrl(chunk?.web?.uri) ? [{ title: chunk.web.title || "Gemini Google Search 출처", url: chunk.web.uri }] : []);
  return { sources, supports: Array.isArray(grounding?.groundingSupports) ? grounding.groundingSupports : [] };
}

function addCitationMarkers(text: string, sources: SearchSource[], references: Array<{ start: number; end: number; sourceIndex: number }>): string {
  const valid = references.filter((reference) => reference.sourceIndex >= 0 && reference.start >= 0 && reference.end > reference.start).sort((a, b) => b.end - a.end);
  let result = text;
  const used = new Set<string>();
  for (const reference of valid) {
    const key = `${reference.start}:${reference.end}:${reference.sourceIndex}`;
    if (used.has(key)) continue;
    used.add(key);
    const marker = ` [${reference.sourceIndex + 1}]`;
    result = `${result.slice(0, reference.end)}${marker}${result.slice(reference.end)}`;
  }
  if (!valid.length && sources.length && result.trim()) {
    const firstBreak = result.indexOf("\n\n");
    const insertAt = firstBreak > 0 ? firstBreak : result.length;
    result = `${result.slice(0, insertAt).trimEnd()} [1]${result.slice(insertAt)}`;
  }
  return result;
}

function buildPrompt(input: SearchInput): string {
  const selectedSources = (input.sources ?? []).map((source) => sourceLabels[source] ?? source).join(", ") || "제한 없음";
  const period = input.period ?? "30d";
  const periodText: Record<string, string> = { "7d": "최근 7일", "30d": "최근 30일", "1y": "최근 1년", all: "전체 기간" };
  const templateSection = input.templateMarkdown?.trim() ? `\n\n업로드된 문서 양식 분석 결과 (${input.templateFileName ?? "업로드 양식"}):\n---\n${input.templateMarkdown.slice(0, 30000)}\n---\n위 양식의 제목·항목명·문단 순서·표 구조를 최대한 유지하고, 생성 결과가 이 구조를 따르도록 작성하세요.` : "";
  return `당신은 한국어 이슈 대응·성과 보고서 작성자입니다. 아래 이슈를 웹 검색으로 조사해 사실과 출처를 확인하세요.

이슈 입력:
${input.query?.slice(0, 5000) ?? ""}

보고서 유형: ${input.reportType ?? "현황 · 문제점 · 대응방향 · 향후계획"}
검색 기간: ${periodText[period] ?? period} (이 기간의 자료를 우선 검색하고, 오래된 자료는 배경 설명에만 사용)
검색 소스 유형: ${selectedSources}

다음 형식으로 작성하세요:
제목
핵심 요약
현황
문제점
대응방향
효과성
시사점
참고 출처

각 섹션은 간결하되 보고에 사용할 수 있도록 구체적으로 작성하세요. 검색 결과로 확인되지 않은 사실은 단정하지 말고 '확인 필요'로 표시하세요. 본문 안에는 URL을 직접 쓰지 말고 근거가 있는 문장 뒤에 [출처 확인]이라고 쓰지 말며, 검색 도구가 제공하는 출처 연결을 바탕으로 답변하세요. 참고 출처에는 확인된 자료의 제목과 핵심 내용을 포함하세요. 최대 20개 자료를 활용하세요.${templateSection}`;
}

function geminiTimeRangeFilter(period: string | undefined): { startTime: string; endTime: string } | undefined {
  if (!period || period === "all") return undefined;
  const end = new Date();
  const start = new Date(end);
  if (period === "7d") start.setUTCDate(start.getUTCDate() - 7);
  else if (period === "30d") start.setUTCDate(start.getUTCDate() - 30);
  else if (period === "1y") start.setUTCFullYear(start.getUTCFullYear() - 1);
  else return undefined;
  const withoutFractionalSeconds = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { startTime: withoutFractionalSeconds(start), endTime: withoutFractionalSeconds(end) };
}

async function fetchJson(url: string, init: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const raw = await response.text();
    let data: any = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!response.ok) {
      const providerMessage = data?.error?.message || data?.error?.status || data?.message;
      throw new Error(providerMessage ? `HTTP ${response.status}: ${providerMessage}` : `HTTP ${response.status} 응답`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function runOpenAI(input: SearchInput, key: string, maxSources: number): Promise<ProviderResult> {
  const started = Date.now();
  try {
    const selectedDomains = [...new Set((input.sources ?? []).flatMap((source) => sourceDomains[source] ?? []))];
    const webSearchTool: Record<string, unknown> = { type: "web_search", search_context_size: "high" };
    if (selectedDomains.length) webSearchTool.filters = { allowed_domains: selectedDomains };
    const response = await fetchJson("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: OPENAI_MODEL, tools: [webSearchTool], input: buildPrompt(input) }) });
    const data = collectOpenAIData(response);
    const sources = dedupeSources(data.sources, maxSources);
    const sourceIndex = new Map(sources.map((source, index) => [normalizeUrl(source.url), index]));
    const references = data.annotations.flatMap((annotation) => {
      const index = sourceIndex.get(normalizeUrl(annotation.url));
      return index === undefined ? [] : [{ start: annotation.start_index ?? annotation.startIndex ?? -1, end: annotation.end_index ?? annotation.endIndex ?? -1, sourceIndex: index }];
    });
    return { status: "success", text: addCitationMarkers(textFromOpenAI(response), sources, references), sources, responseMs: Date.now() - started, model: OPENAI_MODEL };
  } catch (error: unknown) {
    return { status: "error", sources: [], error: error instanceof Error && error.name === "AbortError" ? "요청 시간이 120초를 초과했습니다." : error instanceof Error ? error.message : "OpenAI 요청 중 알 수 없는 오류가 발생했습니다.", responseMs: Date.now() - started, model: OPENAI_MODEL };
  }
}

async function runGemini(input: SearchInput, key: string, maxSources: number): Promise<ProviderResult> {
  const started = Date.now();
  try {
    const timeRangeFilter = geminiTimeRangeFilter(input.period);
    const googleSearchTool = timeRangeFilter ? { google_search: { timeRangeFilter } } : { google_search: {} };
    const response = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify({ contents: [{ parts: [{ text: buildPrompt(input) }] }], tools: [googleSearchTool], generationConfig: { temperature: 0.2, maxOutputTokens: 4000 } }) });
    const data = collectGeminiData(response);
    const sources = dedupeSources(data.sources, maxSources);
    const sourceIndex = new Map(sources.map((source, index) => [normalizeUrl(source.url), index]));
    const references = data.supports.flatMap((support: any) => (support.groundingChunkIndices ?? []).flatMap((chunkIndex: number) => {
      const uri = data.sources[chunkIndex]?.url;
      const index = uri ? sourceIndex.get(normalizeUrl(uri)) : undefined;
      return index === undefined ? [] : [{ start: support.segment?.startIndex ?? -1, end: support.segment?.endIndex ?? -1, sourceIndex: index }];
    }));
    const text = response?.candidates?.[0]?.content?.parts?.map((part: any) => part.text).filter(Boolean).join("\n\n") ?? "";
    return { status: "success", text: addCitationMarkers(text, sources, references), sources, responseMs: Date.now() - started, model: GEMINI_MODEL };
  } catch (error: unknown) {
    return { status: "error", sources: [], error: error instanceof Error && error.name === "AbortError" ? "요청 시간이 120초를 초과했습니다." : error instanceof Error ? error.message : "Gemini 요청 중 알 수 없는 오류가 발생했습니다.", responseMs: Date.now() - started, model: GEMINI_MODEL };
  }
}

function skipped(model: string): ProviderResult {
  return { status: "skipped", sources: [], error: "이 API 키가 입력되지 않아 호출하지 않았습니다.", model };
}

export async function POST(request: Request) {
  let input: SearchInput;
  try { input = await request.json() as SearchInput; } catch { return Response.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 }); }
  const query = input.query?.trim();
  const openAIKey = input.openAIKey?.trim();
  const geminiKey = input.geminiKey?.trim();
  if (!query) return Response.json({ error: "검색할 이슈를 입력해주세요." }, { status: 400 });
  if (!openAIKey && !geminiKey) return Response.json({ error: "OpenAI 또는 Gemini API 키를 하나 이상 입력해주세요." }, { status: 400 });
  const maxSources = Math.min(Math.max(Number(input.maxSources) || MAX_SOURCES, 1), MAX_SOURCES);
  const [openai, gemini] = await Promise.all([openAIKey ? runOpenAI({ ...input, query }, openAIKey, maxSources) : Promise.resolve(skipped(OPENAI_MODEL)), geminiKey ? runGemini({ ...input, query }, geminiKey, maxSources) : Promise.resolve(skipped(GEMINI_MODEL))]);
  return Response.json({ openai, gemini }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
