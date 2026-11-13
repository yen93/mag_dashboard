-- public.ac_google_ads_yes_deals — a cached table of every ActiveCampaign deal whose
-- deal custom field "Google Ads?" (dealCustomFieldMeta id 18) = "Yes".
-- ---------------------------------------------------------------------------
-- Same family/shape as public.ac_indirect_deals (the "Deal Source? = Indirect"
-- cache), but keyed off the "Google Ads?" dropdown instead. It is DELIBERATELY a
-- separate table from the contact-sources pipeline's public.ac_google_ads_deals
-- (which is filled from the GA4/leads chain and scoped differently) — this one is a
-- straight "Google Ads? = Yes" roll of the deal mirror, 2021 → present.
--
-- Coverage: all such deals 2021 → present. The full deal mirror
-- public.activecampaign_deals starts at Jul-2021, so "2021 to present" is simply
-- every Google-Ads-flagged deal in the mirror. (The "Google Ads?" field itself was
-- created in AC on 2022-05-24, so the earliest a deal can carry Yes is mid-2022.)
--
-- How it is filled: the "Google Ads?" field value is NOT stored in the deal mirror,
-- so the ac-google-ads-yes-deals-sync edge function pulls field-18 values from the
-- AC REST API, keeps the deal_ids flagged Yes, and passes them to
-- reload_ac_google_ads_yes_deals(_ids), which UPSERTS those ids onto the local
-- mirror (+ contacts/accounts for names). value_aud, fy and cal_yr are derived with
-- the same shared helpers the rest of the dashboard uses. The rpc NEVER deletes or
-- truncates — a deal that drops out of the Yes feed keeps its last-synced row.

create table if not exists public.ac_google_ads_yes_deals (
  deal_id        text primary key,     -- activecampaign_deals.id
  title          text,
  google_ads     text not null,        -- the literal "Google Ads?" option (always "Yes")
  pipeline_id    text,                 -- activecampaign_deals."group"
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

create index if not exists ac_google_ads_yes_deals_cdate_idx  on public.ac_google_ads_yes_deals (cdate);
create index if not exists ac_google_ads_yes_deals_status_idx on public.ac_google_ads_yes_deals (status);
create index if not exists ac_google_ads_yes_deals_fy_idx     on public.ac_google_ads_yes_deals (fy);

-- Read-only to the dashboard's roles; the sync writes as the service role.
alter table public.ac_google_ads_yes_deals enable row level security;

-- reload_ac_google_ads_yes_deals(_ids jsonb) — UPSERT-ONLY rebuild (never truncates).
-- _ids = a JSON array of { "id": "<deal_id>", "source": "<Google Ads? value>" } for
-- every Yes deal, built by the edge function from the AC field-18 data. Rows are
-- UPSERTed on the deal_id PK (ON CONFLICT DO UPDATE); an empty payload is refused, so
-- a failed sync never wipes the table. A deal that drops out of the Yes feed KEEPS its
-- last-synced row rather than being deleted.
create or replace function public.reload_ac_google_ads_yes_deals(_ids jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n int;
begin
  if _ids is null or jsonb_typeof(_ids) <> 'array' or jsonb_array_length(_ids) = 0 then
    raise exception 'reload_ac_google_ads_yes_deals: refusing to reload with empty payload';
  end if;

  create temporary table _gads_ids (deal_id text primary key, google_ads text) on commit drop;
  insert into _gads_ids (deal_id, google_ads)
  select e->>'id', e->>'source'
  from jsonb_array_elements(_ids) e
  where coalesce(e->>'id','') <> ''
  on conflict (deal_id) do nothing;

  -- UPSERT only — no delete/truncate.
  insert into public.ac_google_ads_yes_deals (
    deal_id, title, google_ads, pipeline_id, pipeline_name, stage_id,
    status, status_label, contact_id, contact_name, contact_email,
    account_id, organization, value_raw, value_aud, currency,
    cdate, mdate, event_date, cal_yr, fy, synced_at)
  select
    d.id,
    d.title,
    coalesce(nullif(g.google_ads, ''), 'Yes'),
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
  from _gads_ids g
  join public.activecampaign_deals d on d.id = g.deal_id
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
  on conflict (deal_id) do update set
    title         = excluded.title,
    google_ads    = excluded.google_ads,
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
