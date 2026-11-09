-- public.post_conference_deals — a cached table of every POST-CONFERENCE
-- ("Project Trojan Horse: Post-Conference") ActiveCampaign deal.
-- ---------------------------------------------------------------------------
-- A post-conference deal is defined as any deal in AC deal pipeline
-- (dealGroups) id 17 — "Trojan Horse: Post-Conf" / "PROJECT TROJAN HORSE:
-- POST CONFERENCE (JAYCEL)". Pipeline membership is stored on the deal mirror
-- (public.activecampaign_deals."group"), so — unlike ac_indirect_deals, whose
-- "Deal Source?" field is NOT mirrored — this cache needs NO ActiveCampaign
-- REST call: it is rebuilt purely from the local mirror (+ contacts/accounts
-- for names). The mirror itself is refreshed from AC daily by the
-- activecampaign-deals-sync edge function (05:00 PH), so this cache syncs from
-- AC daily transitively.
--
-- Backs the Nurture & Events cards on public/nurture_events.html:
--   • "Offsite enquiries from past clients" = ALL rows (any status) per FY.
--   • "Offsites booked by past clients"      = WON rows (status=1) per FY.
-- (The sibling "Past keynote clients in nurture" card reads pipeline 3 straight
--  from the mirror and does not need a cache.)
--
-- value_aud, fy and cal_yr are derived with the same shared helpers the rest of
-- the dashboard uses (ac_value_aud / mag_fy_label / mag_cal_yr).

create table if not exists public.post_conference_deals (
  deal_id        text primary key,     -- activecampaign_deals.id
  title          text,
  pipeline_id    text,                 -- activecampaign_deals."group" (always '17')
  pipeline_name  text,
  stage_id       text,
  status         integer,              -- 0 open, 1 won, 2 lost
  status_label   text,                 -- Open / Won / Lost
  contact_id     text,
  contact_name   text,
  contact_email  text,
  account_id     text,
  organization   text,                 -- account name (falls back to the raw org id)
  value_raw      numeric,              -- as stored on the mirror (cents)
  value_aud      numeric,              -- ac_value_aud(value, currency) — AUD dollars
  currency       text,
  cdate          timestamptz,          -- deal created
  mdate          timestamptz,          -- deal last modified
  event_date     date,
  cal_yr         integer,              -- calendar year of cdate (mag_cal_yr)
  fy             text,                 -- AU financial year END-year label of cdate (mag_fy_label)
  synced_at      timestamptz default now()
);

create index if not exists post_conference_deals_cdate_idx  on public.post_conference_deals (cdate);
create index if not exists post_conference_deals_status_idx on public.post_conference_deals (status);
create index if not exists post_conference_deals_fy_idx     on public.post_conference_deals (fy);

-- Read-only to the dashboard's roles; the rebuild writes as the function owner.
-- (The dashboard reads via the direct pg owner connection, which bypasses RLS.)
alter table public.post_conference_deals enable row level security;

-- reload_post_conference_deals() — UPSERT-ONLY rebuild from the deal mirror.
-- ---------------------------------------------------------------------------
-- Takes no arguments: it selects every pipeline-17 deal currently in
-- public.activecampaign_deals and UPSERTs it onto this cache by deal_id
-- (ON CONFLICT DO UPDATE). It NEVER deletes or truncates (per the global
-- "upsert, never truncate" rule), so a failed or empty mirror can never wipe
-- the cache; a deal moved out of pipeline 17 keeps its last-synced row.
-- Returns the number of rows upserted.
create or replace function public.reload_post_conference_deals()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n int;
begin
  insert into public.post_conference_deals (
    deal_id, title, pipeline_id, pipeline_name, stage_id,
    status, status_label, contact_id, contact_name, contact_email,
    account_id, organization, value_raw, value_aud, currency,
    cdate, mdate, event_date, cal_yr, fy, synced_at)
  select
    d.id,
    d.title,
    d."group",
    coalesce(pm.name, 'Pipeline ' || d."group"),
    d.stage,
    d.status,
    case d.status when 0 then 'Open' when 1 then 'Won' when 2 then 'Lost' else 'Unknown' end,
    d.contact,
    nullif(trim(coalesce(c."firstName", '') || ' ' || coalesce(c."lastName", '')), ''),
    c.email,
    d.account,
    coalesce(a.name, d.organization),
    d.value,
    public.ac_value_aud(d.value, d.currency),
    d.currency,
    d.cdate,
    d.mdate,
    d.event_date,
    public.mag_cal_yr(d.cdate),
    public.mag_fy_label(d.cdate),
    now()
  from public.activecampaign_deals d
  left join public.activecampaign_contacts c on c.id = d.contact
  left join public.activecampaign_accounts a on a.id = d.account
  left join (values
      ('3',  'Keynotes/Workshops/Immersive (LIV)'),
      ('5',  'MAG Team Offsite'),
      ('7',  'The Tailor'),
      ('9',  'Executive X (2024)'),
      ('14', 'Executive X Master'),
      ('17', 'Trojan Horse: Post-Conf'),
      ('18', 'Leader X'),
      ('19', 'NRL Pre-Season 2027'),
      ('20', 'Trojan Horse: Post-Exec X')
    ) pm(id, name) on pm.id = d."group"
  where d."group" = '17'
  on conflict (deal_id) do update set
    title         = excluded.title,
    pipeline_id   = excluded.pipeline_id,
    pipeline_name = excluded.pipeline_name,
    stage_id      = excluded.stage_id,
    status        = excluded.status,
    status_label  = excluded.status_label,
    contact_id    = excluded.contact_id,
    contact_name  = excluded.contact_name,
    contact_email = excluded.contact_email,
    account_id    = excluded.account_id,
    organization  = excluded.organization,
    value_raw     = excluded.value_raw,
    value_aud     = excluded.value_aud,
    currency      = excluded.currency,
    cdate         = excluded.cdate,
    mdate         = excluded.mdate,
    event_date    = excluded.event_date,
    cal_yr        = excluded.cal_yr,
    fy            = excluded.fy,
    synced_at     = excluded.synced_at;

  get diagnostics n = row_count;
  return n;
end;
$$;
