-- Internal ticketing / feedback board for MAG team members.
--
-- Backs the AI & Automation › Ticketing page (public/ticketing.html,
-- /api/tickets). Any signed-in MAG team member (full-access, non-restricted)
-- can FILE a ticket — to report an issue, leave general feedback/suggestions,
-- give feedback about a specific build, or request a new build. Admins triage:
-- change status/priority, assign, and add internal notes.
--
-- Written LIVE by the dashboard server (server/metrics/tickets.js) over the
-- direct pooled pg connection (SUPABASE_DB_URL) — there is NO sync routine and
-- NO edge function; the server INSERTs on submit and UPDATEs on triage. RLS is
-- on with no policies (the owner pooled connection bypasses it, same posture as
-- the other dashboard cache tables); nothing else should touch this table.

create table if not exists public.dashboard_tickets (
  id                 bigint generated always as identity primary key,

  -- What kind of ticket this is (drives the filing form + the board filters).
  --   issue          — report a bug / something broken
  --   feedback       — general feedback or a suggestion
  --   build_feedback — feedback about a specific existing build/page
  --   build_request  — request a brand-new build/feature
  --   other          — anything else
  ticket_type        text        not null
    check (ticket_type in ('issue', 'feedback', 'build_feedback', 'build_request', 'other')),

  title              text        not null,
  description        text,

  -- Which dashboard area / build this is about (free text; '' / null = general,
  -- not tied to one build). e.g. 'Marketing · Spend & ROI', 'Sales · Conferences'.
  related_build      text,

  priority           text        not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'urgent')),

  -- Triage lifecycle.
  status             text        not null default 'open'
    check (status in ('open', 'in_progress', 'resolved', 'closed')),

  -- Who filed it (from the signed-in JWT — never user-supplied).
  submitted_by_email text        not null,
  submitted_by_name  text,

  -- Triage fields (admins only).
  assignee           text,                 -- free-text owner, e.g. a name/email
  admin_notes        text,                 -- internal triage notes

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.dashboard_tickets is
  'Internal ticketing/feedback board behind the AI & Automation > Ticketing page. Written live by the dashboard server (no sync/edge fn): team members INSERT on submit, admins UPDATE on triage. RLS on, no policies (owner pooled connection only).';

create index if not exists dashboard_tickets_status_idx       on public.dashboard_tickets (status);
create index if not exists dashboard_tickets_type_idx         on public.dashboard_tickets (ticket_type);
create index if not exists dashboard_tickets_created_idx      on public.dashboard_tickets (created_at desc);
create index if not exists dashboard_tickets_submitter_idx    on public.dashboard_tickets (submitted_by_email);

alter table public.dashboard_tickets enable row level security;  -- no policies: owner pooled connection only, like the other dashboard tables

-- Keep updated_at fresh on every triage UPDATE.
create or replace function public.dashboard_tickets_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists dashboard_tickets_set_updated_at on public.dashboard_tickets;
create trigger dashboard_tickets_set_updated_at
  before update on public.dashboard_tickets
  for each row execute function public.dashboard_tickets_touch_updated_at();
