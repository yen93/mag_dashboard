-- public.ga4_click_to_call_monthly — monthly GA4 "click_to_call" (phone-click) events,
-- split by acquisition channel, per Australian financial year.
-- ---------------------------------------------------------------------------
-- Backs the "Phone enquiries" KPI card + the new "Phone enquiries · Click-to-call"
-- graph/table section on public/website_search.html (Marketing → Website & Search).
--
-- One row per (year_month, channel): each weekly run of the `ga4-click-to-call-sync`
-- edge function pulls the GA4 `click_to_call` event count (by `yearMonth` +
-- `sessionSourceMedium`) from the GA4 Data API (`runReport` on property 363754280),
-- buckets each source/medium into a small fixed channel set
-- (Google Ads / Bing Ads / Organic / Direct / Other), and UPSERTS one row per
-- (year_month, channel). For every month that has any click_to_call activity the
-- function emits ALL channels (0-filled), so a stored value always equals GA4's
-- current figure — no stale channel rows can linger.
--
-- UPSERT-ONLY / NEVER TRUNCATE:
--   • `reload_ga4_click_to_call_monthly(_rows jsonb)` upserts on (year_month, channel);
--     re-running recomputes every month in place and never deletes history.
--   • A `BEFORE DELETE` trigger blocks DELETE (TRUNCATE is never used).

create table if not exists public.ga4_click_to_call_monthly (
  year_month  text        not null,                 -- 'YYYYMM' e.g. '202610'
  channel     text        not null,                 -- Google Ads / Bing Ads / Organic / Direct / Other
  fy_end      int         not null,                 -- Australian FY END year (2027 = FY27, Jul 2026–Jun 2027)
  events      bigint      not null default 0,       -- click_to_call event count
  synced_at   timestamptz not null default now(),
  primary key (year_month, channel)
);

comment on table public.ga4_click_to_call_monthly is
  'Upsert-only monthly GA4 click_to_call (phone-click) events by channel per AU financial year. Filled by ga4-click-to-call-sync; dashboard SELECTs + aggregates per FY / per month.';

create index if not exists ga4_click_to_call_monthly_fy_idx
  on public.ga4_click_to_call_monthly (fy_end, year_month);

-- Read-only to the dashboard's direct pg connection; writes via security-definer RPC.
alter table public.ga4_click_to_call_monthly enable row level security;

-- Guard trigger: forbid DELETE so rows can only ever be inserted or upserted on conflict.
create or replace function public.ga4_click_to_call_monthly_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'public.ga4_click_to_call_monthly is upsert-only: DELETE is not permitted';
end;
$$;

drop trigger if exists ga4_click_to_call_monthly_forbid_delete on public.ga4_click_to_call_monthly;
create trigger ga4_click_to_call_monthly_forbid_delete
  before delete on public.ga4_click_to_call_monthly
  for each row execute function public.ga4_click_to_call_monthly_no_delete();

-- reload_ga4_click_to_call_monthly(_rows jsonb)
-- Upserts one row per (year_month, channel) from a JSONB array built by the
-- ga4-click-to-call-sync edge function. Refuses empty payloads; never deletes/truncates.
create or replace function public.reload_ga4_click_to_call_monthly(_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n int;
begin
  if _rows is null or jsonb_typeof(_rows) <> 'array' or jsonb_array_length(_rows) = 0 then
    raise exception 'reload_ga4_click_to_call_monthly: refusing to upsert with empty payload';
  end if;

  insert into public.ga4_click_to_call_monthly (year_month, channel, fy_end, events, synced_at)
  select
    r.year_month,
    r.channel,
    r.fy_end,
    coalesce(r.events, 0),
    now()
  from jsonb_to_recordset(_rows) as r(
    year_month text,
    channel    text,
    fy_end     int,
    events     bigint
  )
  where r.year_month is not null and r.channel is not null and r.fy_end is not null
  on conflict (year_month, channel) do update set
    fy_end    = excluded.fy_end,
    events    = excluded.events,
    synced_at = excluded.synced_at;

  get diagnostics n = row_count;
  return n;
end;
$$;
