-- Education Leads review (Sales tab). Liv / Julienne review the org-level education leads
-- the discovery finder scrapes into public.auto_found_educ_leads, tagging each one
-- 'Send intro' or skip from the dashboard (replaces the old "Liv's Remark" column in the
-- ai_scraped_educ_leads Google Sheet). The decision is written to auto_found_educ_leads.status
-- ('Send intro' / 'skip'; 'new' = still to review — the finder's default, and the value a
-- reset restores). The daily discovery run only upserts BRAND-NEW orgs (it dedups against
-- existing org_name_norm), so a review written here is never clobbered.
--
-- This append-only log records WHO decided WHAT and WHEN (auto_found_educ_leads has no
-- reviewer column). Same shape as public.alternate_leads_review_log.
create table if not exists public.auto_found_educ_leads_review_log (
  id          bigserial primary key,
  lead_id     bigint not null,
  decision    text,                      -- 'Send intro' | 'skip' | null (reset to 'new'/for-review)
  action      text not null default 'set' check (action in ('set','reset')),
  set_by      text not null,
  created_at  timestamptz not null default now()
);
create index if not exists auto_found_educ_leads_review_log_lead_idx
  on public.auto_found_educ_leads_review_log (lead_id, created_at desc);
alter table public.auto_found_educ_leads_review_log enable row level security;  -- service-role / direct pg only
