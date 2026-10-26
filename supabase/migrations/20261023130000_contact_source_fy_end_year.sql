-- GA4 Leads Tracker: switch the FY column from START-year to END-year labelling so it
-- MATCHES the ROAS tab and the standard Australian FY convention (an AU financial year
-- runs Jul 1 → Jun 30 and is named by its END year: Jul 2024–Jun 2025 = "FY25").
--
-- Before: mag_fy_label() returned the START year (Jul 2026 → "FY26"), which was off by one
-- vs roas.js's END-year derivation (same period = "FY27"). Now both read "FY27".
--
-- fy is a GENERATED STORED column driven by public.mag_fy_label(cdate); replacing the
-- function body alone does NOT recompute stored rows, so drop the column, replace the
-- helper, then re-add it (re-adding recomputes every row, incl. the static roas-<deal_id>
-- audit rows). cal_yr (calendar year) is unaffected and left in place. mag_fy_label has
-- no other consumer (verified: no view/function references it; only this generated column).

alter table public.ga4_ac_contact_source
  drop column if exists fy;

-- END-year label: FY + last two digits of the FY END year (AU FY ends Jun 30).
-- A date in Jul–Dec belongs to the FY ending the following year; Jan–Jun to the FY
-- ending that year. e.g. Oct 2026 -> "FY27"; May 2026 -> "FY26".
create or replace function public.mag_fy_label(ts timestamptz)
  returns text language sql immutable as
$$
  select case when ts is null then null
    else 'FY' || right(fy_end::text, 2)
  end
  from (
    select case when extract(month from d) >= 7
                then extract(year from d)::int + 1
                else extract(year from d)::int end as fy_end
    from (select (ts at time zone 'UTC')::date as d) q
  ) s
$$;

-- re-add the generated column (recomputes for all existing rows)
alter table public.ga4_ac_contact_source
  add column if not exists fy text generated always as (public.mag_fy_label(cdate)) stored;
