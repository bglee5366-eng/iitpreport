import type { StoredReport } from "../../../lib/report-storage";

export const runtime = "nodejs";

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return { url, key, publicKey: !process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY };
}

function ownerId(request: Request) {
  const config = supabaseConfig();
  if (config?.publicKey) return "anonymous";
  return request.headers.get("oai-authenticated-user-id") ?? "anonymous";
}

function reportFromRow(row: any): StoredReport {
  return { id: row.id, title: row.title, query: row.query, reportType: row.report_type, period: row.period, sources: Array.isArray(row.sources) ? row.sources : [], templateFileName: row.template_file_name ?? undefined, createdAt: row.created_at, results: row.results };
}

async function supabaseRequest(path: string, init: RequestInit = {}) {
  const config = supabaseConfig();
  if (!config) throw new Error("Supabase 환경변수가 설정되지 않았습니다.");
  const headers = new Headers(init.headers);
  headers.set("apikey", config.key);
  headers.set("Content-Type", "application/json");
  return fetch(`${config.url}/rest/v1/${path}`, { ...init, headers });
}

export async function POST(request: Request) {
  if (!supabaseConfig()) return Response.json({ configured: false, error: "Supabase 환경변수가 설정되지 않았습니다." }, { status: 503 });
  try {
    const input = await request.json() as StoredReport;
    if (!input.title || !input.query || !input.results) return Response.json({ error: "저장할 보고서 데이터가 부족합니다." }, { status: 400 });
    const response = await supabaseRequest("reports", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: ownerId(request), title: input.title, query: input.query, report_type: input.reportType, period: input.period, sources: input.sources ?? [], template_file_name: input.templateFileName ?? null, results: input.results }) });
    if (!response.ok) return Response.json({ error: `Supabase 저장 실패 (${response.status})`, detail: await response.text() }, { status: 502 });
    const rows = await response.json() as any[];
    return Response.json({ configured: true, report: reportFromRow(rows[0]) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "보고서 저장 중 오류가 발생했습니다." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "보고서 ID가 필요합니다." }, { status: 400 });
  if (!supabaseConfig()) return Response.json({ configured: false, error: "Supabase 환경변수가 설정되지 않았습니다." }, { status: 503 });
  try {
    const query = `reports?select=*&id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId(request))}&limit=1`;
    const response = await supabaseRequest(query);
    if (!response.ok) return Response.json({ error: `Supabase 조회 실패 (${response.status})`, detail: await response.text() }, { status: 502 });
    const rows = await response.json() as any[];
    if (!rows[0]) return Response.json({ error: "저장된 보고서를 찾을 수 없습니다." }, { status: 404 });
    return Response.json({ configured: true, report: reportFromRow(rows[0]) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "보고서 조회 중 오류가 발생했습니다." }, { status: 500 });
  }
}
