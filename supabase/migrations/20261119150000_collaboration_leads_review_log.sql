-- Collaboration Leads review (Marketing > More tab). Cloverly, Julienne, and James
-- review the potential podcast, influencer, media, and social-media collaboration leads
-- discovered weekly into public.collaboration_leads, tagging each one 'Send intro' or
-- 'Skip' from the dashboard.
--
-- Tagging writes public.collaboration_leads.outreach_status using the table's existing
-- CHECK constraint values:
--   'approved' = Send intro (approved for outreach)
--   'rejected' = Skip (not pursued)
--   'new'      = Reset / pending review (the weekly finder's default)
--
-- The weekly discovery finder (find-collaborators) inserts with
-- ON CONFLICT (brand_name_normalized) DO NOTHING, so reviews written here are never
-- overwritten by subsequent weekly runs.
--
-- This append-only log records WHO decided WHAT and WHEN (collaboration_leads has no
-- reviewer column). Same pattern as alternate_leads_review_log and
-- auto_found_educ_leads_review_log, using uuid lead_id to match collaboration_leads.id.
create table if not exists public.collaboration_leads_review_log (
  id          bigserial primary key,
  lead_id     uuid not null references public.collaboration_leads (id) on delete cascade,
  decision    text,                      -- 'Send intro' | 'skip' | null (reset to 'new'/for-review)
  action      text not null default 'set' check (action in ('set', 'reset')),
  set_by      text not null,
  created_at  timestamptz not null default now()
);

create index if not exists collaboration_leads_review_log_lead_idx
  on public.collaboration_leads_review_log (lead_id, created_at desc);

alter table public.collaboration_leads_review_log enable row level security;  -- service-role / direct pg only
