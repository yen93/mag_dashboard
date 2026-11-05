-- Re-create the renamed reload rpc body against the renamed table.
-- (20261105130000 renamed the function, but ALTER FUNCTION ... RENAME does not rewrite
-- the body, which still pointed at public.ac_bureau_deals.) See 20261105120000 for the
-- original definition — this is identical except the table name and temp-table/error text.

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

  delete from public.ac_indirect_deals where deal_id is not null;

  insert into public.ac_indirect_deals (
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
    ) pm(id, name) on pm.id = d."group";

  get diagnostics n = row_count;
  return n;
end;
$$;
