-- Alternate Leads review (Sales tab). Liv / Julienne tag each lead 'Send intro' or skip from the
-- dashboard; the decision is written to alternate_leads.sheet_remark ('Send intro' / '5A' = skip,
-- the same values the old Google-Sheet review used, so downstream automations are unchanged).
-- This append-only log records WHO decided WHAT and WHEN (alternate_leads has no reviewer column).
create table if not exists public.alternate_leads_review_log (
  id          bigserial primary key,
  lead_id     bigint not null,
  decision    text,                      -- 'Send intro' | '5A' (skip) | null (reset to for-review)
  action      text not null default 'set' check (action in ('set','reset')),
  set_by      text not null,
  created_at  timestamptz not null default now()
);
create index if not exists alternate_leads_review_log_lead_idx on public.alternate_leads_review_log (lead_id, created_at desc);
alter table public.alternate_leads_review_log enable row level security;  -- service-role / direct pg only
