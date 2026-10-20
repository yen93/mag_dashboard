-- GA4 Leads Tracker: add FY, Cal. Yr. and JC's Manual Tag columns to the
-- ga4_ac_contact_source cache table (surfaced on ac_contact_sources.html).
--
-- * cal_yr / fy are a pure function of each row's cdate (the contact Created date the
--   page sorts/filters on) — implemented as GENERATED STORED columns via IMMUTABLE
--   helpers, so they need NO sync maintenance and are correct even for the static
--   roas-<deal_id> audit rows. FY starts Jul 1 (Australian FY) and is labelled
--   "FY2026-27" to match public.mag_gads_direct_inbound_lead_source.fy. Computed in
--   UTC, consistent with the page's existing cdate date handling (the JS filter slices
--   the UTC date).
-- * jc_manual_tag mirrors mag_gads_direct_inbound_lead_source.jc_final_attr (e.g.
--   "Could be SEO or Paid Ad"), joined by deal_id. A BEFORE INSERT/UPDATE OF deal_id
--   trigger keeps it in sync automatically, so NEITHER rebuild_ga4_ac_matches() NOR
--   update_ga4_contact_deals() needs editing — the tag follows deal_id no matter which
--   job (re)links it, and the static roas rows keep whatever the one-time backfill set.

-- ---- immutable helpers for the generated columns -------------------------------
create or replace function public.mag_cal_yr(ts timestamptz)
  returns int language sql immutable as
$$ select extract(year from (ts at time zone 'UTC')::date)::int $$;

create or replace function public.mag_fy_label(ts timestamptz)
  returns text language sql immutable as
$$
  select case when ts is null then null
    else 'FY' || fy_start::text || '-' || right((fy_start + 1)::text, 2)
  end
  from (
    select case when extract(month from d) >= 7
                then extract(year from d)::int
                else extract(year from d)::int - 1 end as fy_start
    from (select (ts at time zone 'UTC')::date as d) q
  ) s
$$;

-- ---- columns -------------------------------------------------------------------
alter table public.ga4_ac_contact_source
  add column if not exists cal_yr int  generated always as (public.mag_cal_yr(cdate)) stored,
  add column if not exists fy     text generated always as (public.mag_fy_label(cdate)) stored,
  add column if not exists jc_manual_tag text;

-- ---- jc_manual_tag: follow deal_id -> mag_gads.jc_final_attr via a trigger ------
create or replace function public.ga4cs_set_jc_manual_tag()
  returns trigger language plpgsql
  set search_path to 'public' as
$$
begin
  if NEW.deal_id is null then
    NEW.jc_manual_tag := null;
  else
    select g.jc_final_attr into NEW.jc_manual_tag
    from public.mag_gads_direct_inbound_lead_source g
    where g.deal_id::text = NEW.deal_id::text
    order by g.jc_final_attr nulls last
    limit 1;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_ga4cs_jc_manual_tag on public.ga4_ac_contact_source;
create trigger trg_ga4cs_jc_manual_tag
  before insert or update of deal_id on public.ga4_ac_contact_source
  for each row execute function public.ga4cs_set_jc_manual_tag();

-- ---- one-time backfill for existing rows (incl. the static roas-* audit rows) ---
update public.ga4_ac_contact_source cs
set jc_manual_tag = g.jc_final_attr
from (
  select distinct on (deal_id) deal_id, jc_final_attr
  from public.mag_gads_direct_inbound_lead_source
  where deal_id is not null
  order by deal_id, jc_final_attr nulls last
) g
where cs.deal_id is not null
  and g.deal_id::text = cs.deal_id::text
  and cs.jc_manual_tag is distinct from g.jc_final_attr;
