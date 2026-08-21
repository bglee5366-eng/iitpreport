"use client";

import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { readStoredReports, saveStoredReport } from "../lib/report-storage";
import type { StoredReport } from "../lib/report-storage";
import { MAX_SAVED_TEMPLATES, readStoredTemplates, removeStoredTemplate, saveStoredTemplate } from "../lib/template-storage";
import type { StoredTemplate } from "../lib/template-storage";

type ReportType = "one-page" | "two-page" | "status-response";
type SearchPeriod = "7d" | "30d" | "1y" | "all";
type SessionStatus = "idle" | "saved" | "changed";
type SearchStatus = "idle" | "loading" | "done";
type TemplateStatus = "idle" | "uploading" | "completed" | "error";

type SearchSource = { title: string; url: string };
type ProviderResult = { status: "success" | "error" | "skipped"; text?: string; sources: SearchSource[]; error?: string; warning?: string; searchQueries?: string[]; responseMs?: number; model: string };
type SearchResults = { openai: ProviderResult; gemini: ProviderResult; claude: ProviderResult };

const OPENAI_SESSION_KEY = "issuebrief.openai-api-key";
const GEMINI_SESSION_KEY = "issuebrief.gemini-api-key";
const CLAUDE_SESSION_KEY = "issuebrief.claude-api-key";

const sourceOptions = [
  { id: "public", label: "정부·공공기관", note: "정책·통계·공식 발표" },
  { id: "academic", label: "연구·학술", note: "논문·연구보고서" },
  { id: "news", label: "뉴스", note: "국내외 언론 보도" },
  { id: "company", label: "기업", note: "기업 발표·공시" },
  { id: "global", label: "국제기구", note: "OECD·UN 등" },
];

const defaultSources = sourceOptions.map((source) => source.id);
const periodOptions: Array<{ value: SearchPeriod; label: string }> = [
  { value: "7d", label: "최근 7일" },
  { value: "30d", label: "최근 30일" },
  { value: "1y", label: "최근 1년" },
  { value: "all", label: "전체 기간" },
];

function ProviderResultCard({ name, result, copied, onCopy }: { name: string; result: ProviderResult; copied: boolean; onCopy: () => void }) {
  return (
    <article className={`provider-result ${result.status}`}>
      <div className="provider-result-heading"><div><span className="step-label">{name === "OpenAI" ? "OPENAI WEB SEARCH" : name === "Gemini" ? "GEMINI GOOGLE SEARCH" : "CLAUDE ANALYSIS"}</span><h3>{name}</h3></div><div className="provider-result-actions">{result.status === "success" && <button type="button" className="copy-button" onClick={onCopy}>{copied ? "복사 완료" : "결과 복사"}</button>}<span className="provider-status">{result.status === "success" ? `성공 · ${result.responseMs ?? 0}ms` : result.status === "skipped" ? "키 미입력" : "호출 실패"}</span></div></div>
      {result.status === "success" ? <>
        {result.warning && <div className="provider-warning">{result.warning}{result.searchQueries?.length ? <small>검색어: {result.searchQueries.join(" · ")}</small> : null}</div>}
        <div className="provider-report-text">{result.text}</div>
        <div className="provider-sources"><h4>참고 출처 <span>{result.sources.length}개</span></h4>{result.sources.length ? result.sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>[{index + 1}] {source.title}</a>) : <p>응답에서 확인된 출처가 없습니다.</p>}</div>
      </> : <div className="provider-error"><strong>{result.status === "skipped" ? "이 API는 건너뛰었습니다." : "이 API 호출에 실패했습니다."}</strong><p>{result.error ?? "원인을 확인할 수 없습니다."}</p></div>}
    </article>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [reportType, setReportType] = useState<ReportType>("status-response");
  const [period, setPeriod] = useState<SearchPeriod>("30d");
  const [sources, setSources] = useState(defaultSources);
  const [generated, setGenerated] = useState(false);
  const [openAIKey, setOpenAIKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [claudeKey, setClaudeKey] = useState("");
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("idle");
  const [apiError, setApiError] = useState("");
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [templateStatus, setTemplateStatus] = useState<TemplateStatus>("idle");
  const [templateFileName, setTemplateFileName] = useState("");
  const [templateMarkdown, setTemplateMarkdown] = useState("");
  const [templateError, setTemplateError] = useState("");
  const [savedTemplates, setSavedTemplates] = useState<StoredTemplate[]>([]);
  const [copiedResult, setCopiedResult] = useState("");
  const [savedReportId, setSavedReportId] = useState("");
  const [savingReport, setSavingReport] = useState(false);
  const [savedReports, setSavedReports] = useState<StoredReport[]>([]);

  useEffect(() => {
    const storedOpenAIKey = sessionStorage.getItem(OPENAI_SESSION_KEY) ?? "";
    const storedGeminiKey = sessionStorage.getItem(GEMINI_SESSION_KEY) ?? "";
    const storedClaudeKey = sessionStorage.getItem(CLAUDE_SESSION_KEY) ?? "";
    setOpenAIKey(storedOpenAIKey);
    setGeminiKey(storedGeminiKey);
    setClaudeKey(storedClaudeKey);
    if (storedOpenAIKey || storedGeminiKey || storedClaudeKey) setSessionStatus("saved");
  }, []);

  useEffect(() => {
    setSavedTemplates(readStoredTemplates());
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/reports")
      .then(async (response) => response.ok ? (await response.json() as { reports?: StoredReport[] }).reports ?? [] : [])
      .then((reports) => { if (active) setSavedReports(reports.length ? reports : readStoredReports()); })
      .catch(() => { if (active) setSavedReports(readStoredReports()); });
    return () => { active = false; };
  }, [savedReportId]);

  function toggleSource(sourceId: string) {
    setSources((current) => current.includes(sourceId) ? current.filter((item) => item !== sourceId) : [...current, sourceId]);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) {
      setApiError("먼저 분석할 키워드나 뉴스 기사 본문을 입력해주세요.");
      return;
    }
    if (!openAIKey.trim() && !geminiKey.trim() && !claudeKey.trim()) {
      setApiError("OpenAI, Gemini 또는 Claude API 키를 하나 이상 입력해주세요.");
      setGenerated(false);
      return;
    }
    setApiError("");
    setSearchStatus("loading");
    setGenerated(true);
    setSearchResults(null);
    void fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: query.trim(),
        reportType,
        period,
        sources,
        openAIKey: openAIKey.trim() || undefined,
        geminiKey: geminiKey.trim() || undefined,
        claudeKey: claudeKey.trim() || undefined,
        maxSources: 20,
        templateFileName: templateFileName || undefined,
        templateMarkdown: templateMarkdown || undefined,
      }),
      signal: AbortSignal.timeout(120_000),
    })
      .then(async (response) => {
        const payload = await response.json() as SearchResults & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "검색 요청에 실패했습니다.");
        setSearchResults(payload);
      })
      .catch((error: unknown) => {
        setApiError(error instanceof Error && error.name === "TimeoutError" ? "검색 요청이 120초를 초과했습니다. 잠시 후 다시 시도해주세요." : error instanceof Error ? error.message : "검색 중 알 수 없는 오류가 발생했습니다.");
      })
      .finally(() => setSearchStatus("done"));
  }

  async function handleTemplateUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setTemplateFileName(file.name);
    setTemplateMarkdown("");
    setTemplateError("");
    setTemplateStatus("uploading");
    const formData = new FormData();
    formData.append("file", file);
    try {
      const response = await fetch("/api/template", { method: "POST", body: formData, signal: AbortSignal.timeout(120_000) });
      const payload = await response.json() as { status?: TemplateStatus; markdown?: string; error?: string };
      if (!response.ok || payload.status !== "completed") throw new Error(payload.error ?? "문서 분석에 실패했습니다.");
      setTemplateMarkdown(payload.markdown ?? "");
      setTemplateStatus("completed");
      setSavedTemplates(saveStoredTemplate({ id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `template-${Date.now()}`, fileName: file.name, markdown: payload.markdown ?? "", savedAt: new Date().toISOString() }));
    } catch (error: unknown) {
      setTemplateStatus("error");
      setTemplateError(error instanceof Error && error.name === "TimeoutError" ? "문서 분석이 120초를 초과했습니다." : error instanceof Error ? error.message : "문서 분석 중 알 수 없는 오류가 발생했습니다.");
    }
  }

  function handleSaveSession() {
    sessionStorage.setItem(OPENAI_SESSION_KEY, openAIKey);
    sessionStorage.setItem(GEMINI_SESSION_KEY, geminiKey);
    sessionStorage.setItem(CLAUDE_SESSION_KEY, claudeKey);
    setSessionStatus("saved");
    setApiError("");
  }

  function handleClearSession() {
    sessionStorage.removeItem(OPENAI_SESSION_KEY);
    sessionStorage.removeItem(GEMINI_SESSION_KEY);
    sessionStorage.removeItem(CLAUDE_SESSION_KEY);
    setOpenAIKey("");
    setGeminiKey("");
    setClaudeKey("");
    setSessionStatus("idle");
    setApiError("");
  }

  function handleReset() {
    setQuery("");
    setReportType("status-response");
    setPeriod("30d");
    setSources(defaultSources);
    setGenerated(false);
    setSearchStatus("idle");
    setSearchResults(null);
    setTemplateStatus("idle");
    setTemplateFileName("");
    setTemplateMarkdown("");
    setTemplateError("");
    setApiError("");
    setCopiedResult("");
    setSavedReportId("");
  }

  function applyTemplate(template: StoredTemplate) {
    setTemplateFileName(template.fileName);
    setTemplateMarkdown(template.markdown);
    setTemplateStatus("completed");
    setTemplateError("");
  }

  function deleteTemplate(templateId: string) {
    setSavedTemplates(removeStoredTemplate(templateId));
    if (savedTemplates.find((template) => template.id === templateId)?.fileName === templateFileName) {
      setTemplateFileName("");
      setTemplateMarkdown("");
      setTemplateStatus("idle");
    }
  }

  async function handleSaveReport() {
    if (!searchResults) return;
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `report-${Date.now()}`;
    const report: StoredReport = {
      id,
      title: query.trim().split("\n")[0].slice(0, 80) || "이슈 대응 보고서",
      query: query.trim(),
      reportType,
      period,
      sources,
      templateFileName: templateFileName || undefined,
      templateMarkdown: templateMarkdown || undefined,
      createdAt: new Date().toISOString(),
      results: searchResults,
    };
    setSavingReport(true);
    try {
      const response = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) });
      if (response.ok) {
        const payload = await response.json() as { report?: StoredReport };
        setSavedReportId(payload.report?.id ?? id);
        if (payload.report) setSavedReports((current) => [payload.report as StoredReport, ...current.filter((item) => item.id !== payload.report?.id)].slice(0, 30));
        setApiError("");
      } else {
        saveStoredReport(report);
        setSavedReportId(id);
        setSavedReports((current) => [report, ...current.filter((item) => item.id !== report.id)].slice(0, 30));
        setApiError("Supabase가 아직 설정되지 않아 이 보고서를 현재 브라우저에 임시 저장했습니다.");
      }
    } catch {
      saveStoredReport(report);
      setSavedReportId(id);
      setSavedReports((current) => [report, ...current.filter((item) => item.id !== report.id)].slice(0, 30));
      setApiError("Supabase에 연결하지 못해 이 보고서를 현재 브라우저에 임시 저장했습니다.");
    } finally {
      setSavingReport(false);
    }
  }

  function handleOpenSavedReport() {
    if (!savedReportId) return;
    const reportWindow = window.open(`/report?id=${encodeURIComponent(savedReportId)}`, "_blank", "noopener,noreferrer");
    if (!reportWindow) setApiError("새 탭을 열 수 없습니다. 브라우저의 팝업 차단을 해제해주세요.");
  }

  function openSavedReport(id: string) {
    const reportWindow = window.open(`/report?id=${encodeURIComponent(id)}`, "_blank", "noopener,noreferrer");
    if (!reportWindow) setApiError("새 탭을 열 수 없습니다. 브라우저의 팝업 차단을 해제해주세요.");
  }

  async function copyText(text: string, label: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setCopiedResult(label);
      window.setTimeout(() => setCopiedResult((current) => current === label ? "" : current), 1800);
    } catch {
      setApiError("결과를 클립보드에 복사하지 못했습니다. 브라우저의 클립보드 권한을 확인해주세요.");
    }
  }

  function providerCopyText(name: string, result: ProviderResult) {
    const sources = result.sources.length ? `\n\n참고 출처\n${result.sources.map((source, index) => `[${index + 1}] ${source.title}\n${source.url}`).join("\n")}` : "";
    return `${name}\n\n${result.text ?? ""}${sources}`.trim();
  }

  function allResultsCopyText() {
    if (!searchResults) return "";
    return [providerCopyText("OpenAI", searchResults.openai), providerCopyText("Gemini", searchResults.gemini), providerCopyText("Claude", searchResults.claude)].join("\n\n====================\n\n");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="이슈브리프 홈"><span className="brand-mark">↗</span><span>이슈브리프</span></a>
        <div className="topbar-meta"><span className="status-dot" /><span>초안 생성기</span></div>
      </header>
      <section className="intro"><div className="eyebrow">ISSUE RESPONSE / DRAFT BUILDER</div><h1>복잡한 이슈를<br /><em>한 장의 보고서</em>로 정리하세요.</h1><p>키워드나 기사 본문을 입력하면 핵심 현황과 대응 방향을 빠르게 구조화합니다.</p></section>
      <div className="workspace-grid">
        <section className="saved-reports-panel saved-reports-top" aria-labelledby="saved-reports-title"><div className="saved-reports-heading"><div><span className="step-label">SAVED</span><h2 id="saved-reports-title">저장된 보고서</h2></div><span>{savedReports.length}개</span></div>{savedReports.length ? <div className="saved-reports-list">{savedReports.map((report) => <article className="saved-report-row" key={report.id}><div><strong>{report.title}</strong><small>{new Date(report.createdAt).toLocaleString("ko-KR")}</small></div><button type="button" onClick={() => openSavedReport(report.id)}>새 탭에서 확인</button></article>)}</div> : <p className="saved-reports-empty">저장한 보고서가 여기에 표시됩니다.</p>}</section>
        <form className="control-card" onSubmit={handleSubmit}>
          <div className="card-heading"><div><span className="step-label">01</span><h2>분석할 이슈를 입력하세요</h2></div><span className="required">필수</span></div>
          <label className="field-label" htmlFor="issue-input">키워드 또는 뉴스 기사 본문</label>
          <textarea id="issue-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={"예: 플랫폼 노동자 보호법 개정 논의\n\n기사 본문을 붙여넣어도 좋아요."} rows={6} />
          <div className="character-count">{query.length.toLocaleString()} / 5,000자</div>
          <div className="divider" />
          <div className="card-heading compact"><div><span className="step-label">02</span><h2>보고서 유형</h2></div></div>
          <div className="segmented-control" role="radiogroup" aria-label="보고서 유형"><label className={reportType === "one-page" ? "selected" : ""}><input type="radio" name="reportType" checked={reportType === "one-page"} onChange={() => setReportType("one-page")} /><span>보고용 1장 페이퍼</span></label><label className={reportType === "two-page" ? "selected" : ""}><input type="radio" name="reportType" checked={reportType === "two-page"} onChange={() => setReportType("two-page")} /><span>보고용 2장 페이퍼</span></label><label className={reportType === "status-response" ? "selected" : ""}><input type="radio" name="reportType" checked={reportType === "status-response"} onChange={() => setReportType("status-response")} /><span>현황 · 문제점 · 대응방향 · 향후계획</span></label></div>
          <div className="divider" />
          <div className="card-heading compact"><div><span className="step-label">03</span><h2>검색 조건</h2></div></div>
          <div className="field-label">검색 기간</div>
          <div className="period-list" role="radiogroup" aria-label="검색 기간 선택">{periodOptions.map((option) => <label className={`period-option ${period === option.value ? "selected" : ""}`} key={option.value}><input type="radio" name="searchPeriod" value={option.value} checked={period === option.value} onChange={() => setPeriod(option.value)} /><span className="radio-mark" /><span>{option.label}</span></label>)}</div>
          <div className="field-label source-label">검색 소스 <span>복수 선택</span></div>
          <div className="source-list">{sourceOptions.map((source) => <label className="source-option" key={source.id}><input type="checkbox" checked={sources.includes(source.id)} onChange={() => toggleSource(source.id)} /><span className="checkbox-mark" /><span><strong>{source.label}</strong><small>{source.note}</small></span></label>)}</div>
          <div className="template-settings">
            <div className="key-settings-heading"><div><span className="step-label">04</span><h2>보고서 양식 분석</h2></div><span className="session-only-badge">선택 사항</span></div>
            <p className="key-description">HWP·HWPX·DOCX·PDF·XLSX·XLS 양식을 분석해 제목과 항목 순서를 보고서 생성에 반영합니다.</p>
            <label className="template-upload" htmlFor="template-file"><span className="upload-icon">↑</span><span><strong>문서 양식 업로드</strong><small>파일을 선택하면 서버에서 구조를 분석합니다 · 최대 25MB</small></span><input id="template-file" type="file" accept=".hwp,.hwpx,.docx,.pdf,.xlsx,.xls" onChange={handleTemplateUpload} /></label>
            {templateFileName && <div className="template-file-status"><span className={templateStatus === "completed" ? "file-status-dot complete" : templateStatus === "error" ? "file-status-dot error" : "file-status-dot"} /> <strong>{templateFileName}</strong><span>{templateStatus === "uploading" ? "분석 중..." : templateStatus === "completed" ? "분석 완료 · 생성 프롬프트에 반영됨" : templateStatus === "error" ? "분석 실패" : "대기 중"}</span></div>}
            {templateError && <div className="template-error" role="alert">{templateError}</div>}
            <div className="saved-templates"><div className="saved-templates-heading"><strong>저장된 양식</strong><span>{savedTemplates.length}/{MAX_SAVED_TEMPLATES}</span></div>{savedTemplates.length ? <div className="saved-templates-list">{savedTemplates.map((template) => <div className={`saved-template-row ${templateFileName === template.fileName && templateMarkdown === template.markdown ? "selected" : ""}`} key={template.id}><button type="button" className="saved-template-select" onClick={() => applyTemplate(template)}><span className="template-select-mark" /> <span><strong>{template.fileName}</strong><small>분석 완료 · {new Date(template.savedAt).toLocaleDateString("ko-KR")}</small></span></button><button type="button" className="saved-template-delete" aria-label={`${template.fileName} 삭제`} onClick={() => deleteTemplate(template.id)}>×</button></div>)}</div> : <p>분석을 완료한 양식이 여기에 저장됩니다.</p>}</div>
          </div>
          <div className="key-settings">
            <div className="key-settings-heading"><div><span className="step-label">05</span><h2>API 키 설정</h2></div><span className="session-only-badge">이 브라우저 세션만</span></div>
            <p className="key-description">키는 서버로 전송하거나 보고서 결과에 표시하지 않고, 현재 탭의 세션에만 저장합니다.</p>
            <label className="field-label" htmlFor="openai-key">OpenAI API 키</label>
            <input className="api-key-input" id="openai-key" type="password" value={openAIKey} onChange={(event) => { setOpenAIKey(event.target.value); setSessionStatus("changed"); setApiError(""); }} placeholder="sk-..." autoComplete="off" />
            <label className="field-label" htmlFor="gemini-key">Gemini API 키</label>
            <input className="api-key-input" id="gemini-key" type="password" value={geminiKey} onChange={(event) => { setGeminiKey(event.target.value); setSessionStatus("changed"); setApiError(""); }} placeholder="AIza..." autoComplete="off" />
            <label className="field-label" htmlFor="claude-key">Claude API 키</label>
            <input className="api-key-input" id="claude-key" type="password" value={claudeKey} onChange={(event) => { setClaudeKey(event.target.value); setSessionStatus("changed"); setApiError(""); }} placeholder="sk-ant-..." autoComplete="off" />
            <div className="session-notice"><span className="lock-mark">▣</span><span>탭을 닫으면 저장된 키가 삭제됩니다.</span></div>
            <div className="session-actions"><button type="button" className="secondary-button" onClick={handleSaveSession}>세션 저장</button><button type="button" className="text-button" onClick={handleClearSession}>세션 비우기</button><span className={sessionStatus === "saved" ? "session-status saved" : "session-status"}>{sessionStatus === "saved" ? "저장됨" : sessionStatus === "changed" ? "변경사항 저장 필요" : "저장되지 않음"}</span></div>
          </div>
          {apiError && <div className="api-error" role="alert"><span>!</span><p>{apiError}</p></div>}
          <div className="form-actions"><button type="button" className="reset-button" onClick={handleReset}>↺ <span>입력·결과 리셋</span></button></div>
          <button className="generate-button" type="submit"><span>{generated ? "초안 다시 생성하기" : "보고서 초안 생성하기"}</span><span className="button-arrow">→</span></button>
          <p className="helper-text">현재는 예시 결과가 표시됩니다. API 연결 후 실시간 검색이 지원됩니다.</p>
        </form>
        <section className="result-card" aria-live="polite">
          <div className="result-header"><div><span className="step-label">RESULT</span><h2>생성 결과</h2></div>{searchResults ? <div className="result-header-actions"><button type="button" className="save-report-button" onClick={() => void handleSaveReport()} disabled={savingReport}>{savingReport ? "저장 중..." : savedReportId ? "저장 완료" : "보고서 저장"}</button>{savedReportId && <button type="button" className="open-report-button" onClick={handleOpenSavedReport}>새 탭에서 확인</button>}<button type="button" className="copy-all-button" onClick={() => void copyText(allResultsCopyText(), "all")}>{copiedResult === "all" ? "전체 복사 완료" : "전체 결과 복사"}</button><span className="preview-badge">PREVIEW</span></div> : <span className="preview-badge">PREVIEW</span>}</div>
          {!generated ? <div className="empty-state"><div className="empty-icon">✦</div><h3>보고서 초안이 이곳에 나타납니다</h3><p>왼쪽에서 이슈와 조건을 설정한 뒤<br />생성 버튼을 눌러보세요.</p><div className="empty-line" /><span>OpenAI·Gemini·Claude 결과가 각각 표시됩니다</span></div> : searchStatus === "loading" ? <div className="empty-state loading-state"><div className="empty-icon">⌁</div><h3>검색 엔진과 Claude에서 자료를 찾고 있습니다</h3><p>입력한 API 키가 있는 제공자를<br />가능한 경우 동시에 호출합니다.</p><span className="loading-note">최대 120초까지 걸릴 수 있습니다.</span></div> : searchResults ? <div className="provider-results"><ProviderResultCard name="OpenAI" result={searchResults.openai} copied={copiedResult === "openai"} onCopy={() => void copyText(providerCopyText("OpenAI", searchResults.openai), "openai")} /><ProviderResultCard name="Gemini" result={searchResults.gemini} copied={copiedResult === "gemini"} onCopy={() => void copyText(providerCopyText("Gemini", searchResults.gemini), "gemini")} /><ProviderResultCard name="Claude" result={searchResults.claude} copied={copiedResult === "claude"} onCopy={() => void copyText(providerCopyText("Claude", searchResults.claude), "claude")} /></div> : <div className="empty-state"><div className="empty-icon">!</div><h3>검색 결과를 표시할 수 없습니다</h3><p>왼쪽 오류 안내를 확인한 뒤 다시 시도해주세요.</p></div>}
        </section>
      </div>
      <footer className="page-footer"><span>이슈브리프</span><span>빠른 판단을 위한 보고서 초안 도구</span></footer>
    </main>
  );
}
