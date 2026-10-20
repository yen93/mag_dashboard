-- GA4 Leads Tracker: shorten the FY column label from "FY2026-27" to "FY26".
--
-- fy is a GENERATED STORED column driven by public.mag_fy_label(cdate). Replacing
-- the function body alone does NOT recompute already-stored rows, so we drop the
-- generated column, replace the helper, then re-add the column (re-adding recomputes
-- it for every existing row, incl. the static roas-<deal_id> audit rows). cal_yr is
-- unaffected and left in place.

-- drop the generated column so the helper can be replaced without a dependency conflict
alter table public.ga4_ac_contact_source
  drop column if exists fy;

-- new short label: FY + last two digits of the FY start year (AU FY starts Jul 1),
-- e.g. a cdate in FY starting 2026 -> "FY26".
create or replace function public.mag_fy_label(ts timestamptz)
  returns text language sql immutable as
$$
  select case when ts is null then null
    else 'FY' || right(fy_start::text, 2)
  end
  from (
    select case when extract(month from d) >= 7
                then extract(year from d)::int
                else extract(year from d)::int - 1 end as fy_start
    from (select (ts at time zone 'UTC')::date as d) q
  ) s
$$;

-- re-add the generated column (recomputes for all existing rows)
alter table public.ga4_ac_contact_source
  add column if not exists fy text generated always as (public.mag_fy_label(cdate)) stored;
