export type ReportSource = { title: string; url: string };

export type StoredProviderResult = {
  status: "success" | "error" | "skipped";
  text?: string;
  sources: ReportSource[];
  error?: string;
  warning?: string;
  responseMs?: number;
  model: string;
};

export type StoredReport = {
  id: string;
  title: string;
  query: string;
  reportType: string;
  period: string;
  sources: string[];
  templateFileName?: string;
  createdAt: string;
  results: {
    openai: StoredProviderResult;
    gemini: StoredProviderResult;
    claude: StoredProviderResult;
  };
};

export const REPORT_STORAGE_KEY = "issuebrief.saved-reports";

export function readStoredReports(): StoredReport[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(localStorage.getItem(REPORT_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function saveStoredReport(report: StoredReport): void {
  const reports = readStoredReports().filter((item) => item.id !== report.id);
  localStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify([report, ...reports].slice(0, 30)));
}

export function getStoredReport(id: string): StoredReport | undefined {
  return readStoredReports().find((report) => report.id === id);
}
