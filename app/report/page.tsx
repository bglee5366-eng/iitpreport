"use client";

import { useEffect, useState } from "react";
import { getStoredReport } from "../../lib/report-storage";
import type { StoredProviderResult, StoredReport } from "../../lib/report-storage";

function ProviderReport({ name, result }: { name: string; result: StoredProviderResult }) {
  return (
    <article className="saved-provider-report">
      <div className="saved-provider-heading">
        <div><span className="step-label">{name === "OpenAI" ? "OPENAI WEB SEARCH" : name === "Gemini" ? "GEMINI GOOGLE SEARCH" : "CLAUDE ANALYSIS"}</span><h2>{name}</h2></div>
        <span className={`provider-status ${result.status}`}>{result.status === "success" ? "성공" : result.status === "skipped" ? "키 미입력" : "호출 실패"}</span>
      </div>
      {result.warning && <div className="provider-warning">{result.warning}</div>}
      {result.status === "success" ? <div className="saved-report-text">{result.text}</div> : <div className="provider-error"><strong>결과를 생성하지 못했습니다.</strong><p>{result.error ?? "원인을 확인할 수 없습니다."}</p></div>}
      <div className="provider-sources"><h3>참고 출처 <span>{result.sources.length}개</span></h3>{result.sources.length ? result.sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>[{index + 1}] {source.title}</a>) : <p>응답에서 확인된 출처가 없습니다.</p>}</div>
    </article>
  );
}

export default function SavedReportPage() {
  const [report, setReport] = useState<StoredReport | null>(null);
  const [exporting, setExporting] = useState("");
  const [exportError, setExportError] = useState("");

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) return;
    const localReport = getStoredReport(id);
    void fetch(`/api/reports?id=${encodeURIComponent(id)}`)
      .then(async (response) => response.ok ? (await response.json() as { report?: StoredReport }).report : undefined)
      .then((remoteReport) => setReport(remoteReport ?? localReport ?? null))
      .catch(() => setReport(localReport ?? null));
  }, []);

  async function downloadReport(format: "hwpx" | "docx" | "pdf") {
    if (!report) return;
    setExporting(format);
    setExportError("");
    try {
      const response = await fetch("/api/reports/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format, report }) });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "문서 생성에 실패했습니다.");
      let blob: Blob;
      if (format === "pdf") {
        const payload = await response.json() as { data?: string; fileName?: string; format?: string };
        if (!payload.data || payload.data === "true" || payload.format !== "pdf") throw new Error("서버에서 올바른 PDF 데이터를 받지 못했습니다.");
        const binary = atob(payload.data);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const header = new TextDecoder().decode(bytes.subarray(0, 5));
        if (header !== "%PDF-") throw new Error("PDF 응답 형식이 올바르지 않습니다.");
        blob = new Blob([bytes], { type: "application/pdf" });
      } else {
        blob = await response.blob();
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = format === "pdf" ? `${report.title.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "issue-report"}.pdf` : `${report.title.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "issue-report"}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "문서 생성에 실패했습니다.");
    } finally {
      setExporting("");
    }
  }

  if (!report) return <main className="saved-report-page"><div className="saved-report-empty"><h1>저장된 보고서를 찾을 수 없습니다.</h1><p>원래 탭에서 보고서를 먼저 저장한 뒤 다시 열어주세요.</p><a href="/">이슈브리프로 돌아가기</a></div></main>;

  return <main className="saved-report-page"><header className="saved-report-topbar"><a className="brand" href="/"><span className="brand-mark">↗</span><span>이슈브리프</span></a><span>저장된 보고서 · 새 탭 미리보기</span></header><section className="saved-report-header"><span className="step-label">SAVED REPORT</span><h1>{report.title}</h1><p>저장 시각 {new Date(report.createdAt).toLocaleString("ko-KR")} · 검색 기간 {report.period}</p><div className="saved-report-meta"><span>분석 이슈: {report.query}</span>{report.templateFileName && <span>적용 양식: {report.templateFileName}</span>}</div><div className="export-actions"><strong>문서로 다운로드</strong><button type="button" onClick={() => void downloadReport("hwpx")} disabled={Boolean(exporting)}>{exporting === "hwpx" ? "생성 중..." : "HWPX"}</button><button type="button" onClick={() => void downloadReport("docx")} disabled={Boolean(exporting)}>{exporting === "docx" ? "생성 중..." : "DOCX"}</button><button type="button" onClick={() => void downloadReport("pdf")} disabled={Boolean(exporting)}>{exporting === "pdf" ? "생성 중..." : "PDF"}</button></div>{exportError && <div className="template-error" role="alert">{exportError}</div>}<p className="export-note">저장된 분석 양식의 제목·항목 순서를 기준으로 문서를 생성합니다.</p></section><div className="saved-provider-results"><ProviderReport name="OpenAI" result={report.results.openai} /><ProviderReport name="Gemini" result={report.results.gemini} /><ProviderReport name="Claude" result={report.results.claude} /></div></main>;
}
