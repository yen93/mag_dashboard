-- Email & Partners weekly metrics snapshot cache.
--
-- Backs the Marketing › Email & Partners page (public/email_partners.html,
-- /api/marketing/email-partners). Filled WEEKLY by the Claude Code routine
-- `email-partners-sync` (routines/email-partners-sync.md), which pulls the email
-- KPIs from the ActiveCampaign MCP (run_campaign_performance_report summaryData +
-- list_contacts / list_lists) and the partner deal figures from the existing
-- public.ac_indirect_deals cache, then INSERTs one row per Australian FY per run.
-- The dashboard only ever SELECTs the latest row per FY (same model as
-- public.sales_topline / social_platform_stats).
--
-- APPEND-ONLY by design: every run adds a fresh set of rows (one per FY) so the
-- table keeps a full weekly history. A guard trigger blocks UPDATE and DELETE so
-- the table can never lose rows — only INSERT is allowed.

create table if not exists public.email_partner_metrics (
  id                   bigint generated always as identity primary key,
  run_id               uuid        not null,               -- one id per weekly run (groups a run's FY rows)
  captured_at          timestamptz not null default now(), -- when the run wrote the snapshot
  fy_end               int         not null,               -- Australian FY END year (2027 = FY27, Jul 2026–Jun 2027)
  fy_label             text        not null,               -- 'fy27'
  window_start         date        not null,               -- FY window the email report covered
  window_end           date        not null,

  -- Email performance — AC run_campaign_performance_report `summaryData` for the FY window
  campaigns_sent       int,
  total_sends          bigint,
  open_rate            numeric,     -- percent
  click_rate           numeric,     -- percent
  click_to_open_rate   numeric,     -- percent
  unsubscribe_rate     numeric,     -- percent of sends
  total_unsubscribes   int,
  bounce_rate          numeric,     -- percent
  total_bounces        int,
  total_unique_opens   bigint,
  total_unique_clicks  bigint,

  -- Subscriber snapshot — AC, "as of captured_at" (same value across a run's FY rows)
  active_contacts         int,      -- account-wide ACTIVE contacts (list_contacts status=1 → meta.total)
  bureau_list_subscribers int,      -- SPEAKERS BUREAUS list (id 3) active_subscribers

  -- Partner deals — Supabase public.ac_indirect_deals, per FY (is_tailor splits the two partners)
  bureau_enquiries     int,
  bureau_bookings      int,         -- won (status=1)
  bureau_revenue       numeric,     -- won value_aud
  bureau_contacts      int,         -- distinct contact_id on bureau deals this FY
  tailor_enquiries     int,
  tailor_bookings      int,
  tailor_revenue       numeric,
  tailor_contacts      int,

  summary              jsonb,       -- full AC summaryData + context, for audit
  note                 text,
  created_at           timestamptz not null default now()
);

comment on table public.email_partner_metrics is
  'Append-only weekly snapshots behind the Email & Partners page. Filled by the email-partners-sync routine (AC MCP + ac_indirect_deals); dashboard SELECTs latest row per fy_end. INSERT-only (UPDATE/DELETE blocked by trigger).';

create index if not exists email_partner_metrics_fy_captured_idx
  on public.email_partner_metrics (fy_end, captured_at desc);

alter table public.email_partner_metrics enable row level security;  -- no policies: service role only, like the other caches

-- Append-only guard: allow INSERT, forbid UPDATE/DELETE so a run can never lose history.
create or replace function public.email_partner_metrics_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'public.email_partner_metrics is append-only: % is not permitted', tg_op;
end;
$$;

drop trigger if exists email_partner_metrics_no_mutate on public.email_partner_metrics;
create trigger email_partner_metrics_no_mutate
  before update or delete on public.email_partner_metrics
  for each row execute function public.email_partner_metrics_append_only();
