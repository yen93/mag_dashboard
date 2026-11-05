-- reload_ac_indirect_deals — UPSERT-ONLY rebuild (never truncates).
-- ---------------------------------------------------------------------------
-- Supersedes the delete-all → insert body in 20261105131000. Changes:
--   1. Computes is_tailor = (title ILIKE '%the tailor%') on insert/update.
--   2. NEVER deletes/truncates — rows are UPSERTed on the deal_id PK
--      (ON CONFLICT DO UPDATE). A deal that drops out of the AC "Deal Source?"
--      Indirect feed therefore KEEPS its last-synced row instead of being removed.
-- Everything else (the mirror join, name/pipeline lookups, value_aud/fy/cal_yr
-- helpers, the empty-payload guard) is unchanged from the previous body.

create or replace function public.reload_ac_indirect_deals(_ids jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n int;
begin
  if _ids is null or jsonb_typeof(_ids) <> 'array' or jsonb_array_length(_ids) = 0 then
    raise exception 'reload_ac_indirect_deals: refusing to reload with empty payload';
  end if;

  create temporary table _indirect_ids (deal_id text primary key, deal_source text) on commit drop;
  insert into _indirect_ids (deal_id, deal_source)
  select e->>'id', e->>'source'
  from jsonb_array_elements(_ids) e
  where coalesce(e->>'id','') <> ''
  on conflict (deal_id) do nothing;

  -- UPSERT only — no delete/truncate.
  insert into public.ac_indirect_deals (
    deal_id, title, deal_source, pipeline_id, pipeline_name, stage_id,
    status, status_label, contact_id, contact_name, contact_email,
    account_id, organization, value_raw, value_aud, currency,
    cdate, mdate, event_date, cal_yr, fy, is_tailor, synced_at)
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
    (d.title ilike '%the tailor%'),
    now()
  from _indirect_ids b
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
    ) pm(id, name) on pm.id = d."group"
  on conflict (deal_id) do update set
    title         = excluded.title,
    deal_source   = excluded.deal_source,
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
    is_tailor     = excluded.is_tailor,
    synced_at     = excluded.synced_at;

  get diagnostics n = row_count;
  return n;
end;
$$;
