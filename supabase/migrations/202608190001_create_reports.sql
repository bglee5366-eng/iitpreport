create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null default 'anonymous',
  title text not null,
  query text not null,
  report_type text not null,
  period text not null,
  sources jsonb not null default '[]'::jsonb,
  template_file_name text,
  results jsonb not null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists reports_owner_created_at_idx
  on public.reports (owner_id, created_at desc);

alter table public.reports enable row level security;
grant select, insert on table public.reports to service_role;

-- Publishable-key fallback for the current anonymous app flow.
grant usage on schema public to anon;
grant select, insert on table public.reports to anon;

create policy reports_anon_insert
  on public.reports for insert to anon
  with check (owner_id = 'anonymous');

create policy reports_anon_select
  on public.reports for select to anon
  using (owner_id = 'anonymous');
