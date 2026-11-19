-- Instagram Leads review (Sales tab). Liv, Julienne, and James review AI-extracted
-- speaker Instagram Story leads in public.insta_stories (where org IS NOT NULL and
-- sheet_remark IS NULL and outreach_status IS NULL), tagging each one 'Send intro'
-- or 'Skip' from the dashboard.
--
-- Tagging writes public.insta_stories.outreach_status:
--   'Send intro' = approved for outreach
--   'skip'       = not pursued
--   NULL         = reset / back to pending review
--
-- Legacy rows already triaged in the ai_scraped_insta_stories Google Sheet keep their
-- backfilled sheet_remark ('Send intro' | '5A') and are shown read-only under the
-- Send intro / Skipped filters.
--
-- This append-only log records WHO decided WHAT and WHEN (insta_stories has no
-- reviewer column). Same pattern as alternate_leads_review_log and
-- auto_found_educ_leads_review_log, using bigint lead_id to match insta_stories.id.
create table if not exists public.insta_stories_review_log (
  id          bigserial primary key,
  lead_id     bigint not null references public.insta_stories (id) on delete cascade,
  decision    text,                      -- 'Send intro' | 'skip' | null (reset to for-review)
  action      text not null default 'set' check (action in ('set', 'reset')),
  set_by      text not null,
  created_at  timestamptz not null default now()
);

create index if not exists insta_stories_review_log_lead_idx
  on public.insta_stories_review_log (lead_id, created_at desc);

alter table public.insta_stories_review_log enable row level security;  -- service-role / direct pg only
