alter table public.reports
  add column if not exists template_markdown text;
