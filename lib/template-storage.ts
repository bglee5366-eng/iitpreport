export type StoredTemplate = {
  id: string;
  fileName: string;
  markdown: string;
  savedAt: string;
};

const TEMPLATE_STORAGE_KEY = "issuebrief.saved-templates";
export const MAX_SAVED_TEMPLATES = 5;

export function readStoredTemplates(): StoredTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(localStorage.getItem(TEMPLATE_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.slice(0, MAX_SAVED_TEMPLATES) : [];
  } catch {
    return [];
  }
}

export function saveStoredTemplate(template: StoredTemplate): StoredTemplate[] {
  const current = readStoredTemplates().filter((item) => item.id !== template.id && item.fileName !== template.fileName);
  const next = [template, ...current].slice(0, MAX_SAVED_TEMPLATES);
  localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function removeStoredTemplate(id: string): StoredTemplate[] {
  const next = readStoredTemplates().filter((item) => item.id !== id);
  localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(next));
  return next;
}
