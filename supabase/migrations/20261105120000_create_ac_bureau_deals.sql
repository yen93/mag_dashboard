-- public.ac_bureau_deals — a cached table of every BUREAU ActiveCampaign deal.
-- ---------------------------------------------------------------------------
-- A "bureau" deal is defined (per the owner) STRICTLY as a deal whose AC deal
-- custom field "Deal Source?" (dealCustomFieldMeta id 6) = the option
-- "Indirect (PCO/ Bureau/ Events company)". This is the SINGLE definition used
-- here — it deliberately does NOT reuse the title-heuristic `is_bureau` flag on
-- public.ac_deals_ytd (which diverges from the field, and only covers Jul-2024+).
--
-- Coverage: all such deals 2021 → present. The full deal mirror
-- public.activecampaign_deals already starts at Jul-2021 (min cdate 2021-07-29),
-- so "2021 to present" is simply every bureau deal in the mirror.
--
-- How it is filled: the "Deal Source?" field value is NOT stored in the deal
-- mirror, so the ac-bureau-deals-sync edge function pulls field-6 values from the
-- AC REST API, keeps the deal_ids flagged Indirect, and passes them to
-- reload_ac_bureau_deals(_ids), which rebuilds this table by joining those ids
-- back onto the local mirror (+ contacts/accounts for names). value_aud, fy and
-- cal_yr are derived with the same shared helpers the rest of the dashboard uses.

create table if not exists public.ac_bureau_deals (
  deal_id        text primary key,     -- activecampaign_deals.id
  title          text,
  deal_source    text not null,        -- the literal "Deal Source?" option (Indirect …)
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

create index if not exists ac_bureau_deals_cdate_idx  on public.ac_bureau_deals (cdate);
create index if not exists ac_bureau_deals_status_idx on public.ac_bureau_deals (status);
create index if not exists ac_bureau_deals_fy_idx     on public.ac_bureau_deals (fy);

-- Read-only to the dashboard's roles; the sync writes as the service role.
alter table public.ac_bureau_deals enable row level security;

-- reload_ac_bureau_deals(_ids jsonb)
-- _ids = a JSON array of { "id": "<deal_id>", "source": "<Deal Source? value>" } for
-- every bureau deal, built by the edge function from the AC field-6 data. The whole
-- delete → insert runs in ONE transaction, and an empty payload is refused, so a
-- failed sync never leaves the table empty (previous rows are preserved on rollback).
create or replace function public.reload_ac_bureau_deals(_ids jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n int;
begin
  if _ids is null or jsonb_typeof(_ids) <> 'array' or jsonb_array_length(_ids) = 0 then
    raise exception 'reload_ac_bureau_deals: refusing to reload with empty payload';
  end if;

  create temporary table _bureau_ids (deal_id text primary key, deal_source text) on commit drop;
  insert into _bureau_ids (deal_id, deal_source)
  select e->>'id', e->>'source'
  from jsonb_array_elements(_ids) e
  where coalesce(e->>'id','') <> ''
  on conflict (deal_id) do nothing;

  delete from public.ac_bureau_deals where deal_id is not null;

  insert into public.ac_bureau_deals (
    deal_id, title, deal_source, pipeline_id, pipeline_name, stage_id,
    status, status_label, contact_id, contact_name, contact_email,
    account_id, organization, value_raw, value_aud, currency,
    cdate, mdate, event_date, cal_yr, fy, synced_at)
  select
    d.id,
    d.title,
    b.deal_source,
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
  from _bureau_ids b
  join public.activecampaign_deals d on d.id = b.deal_id
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
    ) pm(id, name) on pm.id = d."group";

  get diagnostics n = row_count;
  return n;
end;
$$;
