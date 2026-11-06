-- public.ga4_website_traffic_snapshots — weekly snapshots of GA4 website sessions
-- and AI-tool referral visits per Australian financial year.
-- ---------------------------------------------------------------------------
-- Backs the "Website sessions" and "Visits from AI tools" KPI cards on
-- public/website_search.html (Marketing → Website & Search).
--
-- One row per (fy_end, snapshot_date): each weekly run of the
-- `ga4-website-traffic-sync` edge function pulls total `sessions` (by `yearMonth`)
-- and AI-assistant `sessions` (by `yearMonth` + `sessionSource`) from the GA4 Data
-- API (`runReport` on property 363754280) and UPSERTS one row per Australian FY
-- for that day's `snapshot_date`.
--
-- UPSERT-ONLY / NEVER TRUNCATE:
--   • `reload_ga4_website_traffic_snapshots(_rows jsonb)` upserts on
--     `(fy_end, snapshot_date)` — re-running on the same date updates that date's
--     rows; every new weekly run inserts a fresh set of `(fy_end, snapshot_date)`
--     rows while keeping all prior weekly snapshots.
--   • A `BEFORE DELETE` trigger blocks `DELETE` (and `TRUNCATE` is never used),
--     guaranteeing historical snapshots are never removed.

create table if not exists public.ga4_website_traffic_snapshots (
  fy_end                int         not null,     -- Australian FY END year (2027 = FY27, Jul 2026–Jun 2027)
  fy_label              text        not null,     -- 'FY27'
  snapshot_date         date        not null,     -- weekly snapshot date (PK part)
  website_sessions      bigint      not null default 0,
  ai_tool_visits        bigint      not null default 0,
  ai_sources_breakdown  jsonb       not null default '{}'::jsonb, -- e.g. {"chatgpt.com": 189, "gemini.google.com": 11}
  synced_at             timestamptz not null default now(),
  primary key (fy_end, snapshot_date)
);

comment on table public.ga4_website_traffic_snapshots is
  'Upsert-only weekly snapshots of GA4 website sessions and AI-tool visits per AU financial year. Filled by ga4-website-traffic-sync; dashboard SELECTs latest snapshot_date per fy_end.';

create index if not exists ga4_website_traffic_snapshots_fy_date_idx
  on public.ga4_website_traffic_snapshots (fy_end, snapshot_date desc);

-- Read-only to the dashboard's direct pg connection; writes via service_role / security definer RPC.
alter table public.ga4_website_traffic_snapshots enable row level security;

-- Guard trigger: forbid DELETE so rows can only ever be inserted or upserted on conflict.
create or replace function public.ga4_website_traffic_snapshots_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'public.ga4_website_traffic_snapshots is upsert-only: DELETE is not permitted';
end;
$$;

drop trigger if exists ga4_website_traffic_snapshots_forbid_delete on public.ga4_website_traffic_snapshots;
create trigger ga4_website_traffic_snapshots_forbid_delete
  before delete on public.ga4_website_traffic_snapshots
  for each row execute function public.ga4_website_traffic_snapshots_no_delete();

-- reload_ga4_website_traffic_snapshots(_rows jsonb)
-- Upserts one row per (fy_end, snapshot_date) from a JSONB array built by the
-- ga4-website-traffic-sync edge function. Refuses empty payloads and never deletes
-- or truncates existing rows.
create or replace function public.reload_ga4_website_traffic_snapshots(_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n int;
begin
  if _rows is null or jsonb_typeof(_rows) <> 'array' or jsonb_array_length(_rows) = 0 then
    raise exception 'reload_ga4_website_traffic_snapshots: refusing to upsert with empty payload';
  end if;

  insert into public.ga4_website_traffic_snapshots (
    fy_end, fy_label, snapshot_date,
    website_sessions, ai_tool_visits, ai_sources_breakdown, synced_at
  )
  select
    r.fy_end,
    coalesce(nullif(r.fy_label, ''), 'FY' || lpad((r.fy_end - 2000)::text, 2, '0')),
    r.snapshot_date,
    coalesce(r.website_sessions, 0),
    coalesce(r.ai_tool_visits, 0),
    coalesce(r.ai_sources_breakdown, '{}'::jsonb),
    now()
  from jsonb_to_recordset(_rows) as r(
    fy_end               int,
    fy_label             text,
    snapshot_date        date,
    website_sessions     bigint,
    ai_tool_visits       bigint,
    ai_sources_breakdown jsonb
  )
  where r.fy_end is not null and r.snapshot_date is not null
  on conflict (fy_end, snapshot_date) do update set
    fy_label             = excluded.fy_label,
    website_sessions     = excluded.website_sessions,
    ai_tool_visits       = excluded.ai_tool_visits,
    ai_sources_breakdown = excluded.ai_sources_breakdown,
    synced_at            = excluded.synced_at;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- Seed initial verified GA4 Data API snapshot (2026-11-06, property 363754280)
-- so the table has immediate baseline rows upon running this migration.
select public.reload_ga4_website_traffic_snapshots('[
  {"fy_end": 2022, "fy_label": "FY22", "snapshot_date": "2026-11-06", "website_sessions": 0,     "ai_tool_visits": 0,   "ai_sources_breakdown": {}},
  {"fy_end": 2023, "fy_label": "FY23", "snapshot_date": "2026-11-06", "website_sessions": 8282,  "ai_tool_visits": 0,   "ai_sources_breakdown": {}},
  {"fy_end": 2024, "fy_label": "FY24", "snapshot_date": "2026-11-06", "website_sessions": 38190, "ai_tool_visits": 0,   "ai_sources_breakdown": {}},
  {"fy_end": 2025, "fy_label": "FY25", "snapshot_date": "2026-11-06", "website_sessions": 49870, "ai_tool_visits": 43,  "ai_sources_breakdown": {"chatgpt.com": 38, "perplexity.ai": 4, "you.com": 1}},
  {"fy_end": 2026, "fy_label": "FY26", "snapshot_date": "2026-11-06", "website_sessions": 56742, "ai_tool_visits": 161, "ai_sources_breakdown": {"chatgpt.com": 141, "gemini.google.com": 8, "perplexity.ai": 5, "copilot.com": 3, "claude.ai": 2, "copilot.cloud.microsoft": 1, "poe.com": 1}},
  {"fy_end": 2027, "fy_label": "FY27", "snapshot_date": "2026-11-06", "website_sessions": 19560, "ai_tool_visits": 15,  "ai_sources_breakdown": {"chatgpt.com": 10, "gemini.google.com": 3, "claude.ai": 1, "copilot.microsoft.com": 1}}
]'::jsonb);
