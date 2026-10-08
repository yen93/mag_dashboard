-- GA4 & Ads Leads Tracking — server-side rebuild of the tab's two tables from the
-- staging data the ga4-ads-leads-sync edge function loads each run:
--   * public.ga4_events_staging          — GA4 form events (per-minute, by source/medium)
--   * public.ga4_calendly_events_staging  — GA4 calendly_form_submit events (for channel)
--   * public.calendly_bookings_staging    — Calendly bookings (email + utm)
--
-- rebuild_ga4_ac_matches() reproduces scripts/match_ga4_ac.sql from the
-- google_ads_leads_tracking repo, with two deliberate changes:
--   1. ga4_ac_contact_source is rebuilt MATCHED-ONLY (unmatched contacts are not
--      inserted) — the "GA4 & Ads Leads Tracking" tab only shows leads with a
--      conversion action, so there is no reason to carry unmatched rows.
--   2. the `channel` column is populated in-line (previously an out-of-band step):
--      ga4_time rows  -> "source / medium"; calendly_email rows -> the source/medium
--      of the nearest GA4 calendly_form_submit session (± tol_seconds of the booking).
-- Idempotent: both output tables are fully rebuilt each run.

create table if not exists public.ga4_calendly_events_staging (
  event_time_utc timestamptz,
  source         text,
  medium         text,
  campaign       text,
  event_count    int
);

-- Truncate the three staging tables (called by the edge function before it loads a
-- fresh batch). Separate from rebuild so the function can load between the two.
create or replace function public.clear_ga4_staging()
returns void
language sql
security definer
set search_path = public
as $$
  truncate public.ga4_events_staging;
  truncate public.ga4_calendly_events_staging;
  truncate public.calendly_bookings_staging;
$$;

create or replace function public.rebuild_ga4_ac_matches(
  window_days int default 60,
  tol_seconds int default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cs_rows  int;
  v_total    int;
  v_events   int;
begin
  -- ===== 1. per-contact rollup (matched-only, with channel) =====
  truncate public.ga4_ac_contact_source;

  insert into public.ga4_ac_contact_source
    (contact_id, email, cdate, source, medium, campaign, match_method,
     confidence, candidate_count, matched_at, time_delta_seconds, channel, updated_at)
  with contacts_scope as (
    select id, lower(email) as email, cdate,
           count(*) over (partition by date_trunc('minute', cdate)) as smc
    from public.activecampaign_contacts
    where cdate >= now() - (interval '1 day' * window_days)
      and email is not null and email <> ''
  ),
  calendly_match as (
    select distinct on (c.id)
           c.id as contact_id,
           coalesce(nullif(b.utm_source, ''), '(calendly)') as source,
           coalesce(nullif(b.utm_medium, ''), 'booking')    as medium,
           coalesce(nullif(b.utm_campaign, ''), b.event_name) as campaign,
           b.booking_created_at as matched_at
    from public.calendly_bookings_staging b
    join contacts_scope c on c.email = lower(b.email)
    order by c.id, b.booking_created_at asc
  ),
  ga4_cand as (
    select c.id as contact_id, g.source, g.medium, g.campaign, g.event_time_utc,
           abs(extract(epoch from (c.cdate - g.event_time_utc))) as delta
    from contacts_scope c
    join public.ga4_events_staging g
      on g.event_time_utc between c.cdate - (interval '1 second' * tol_seconds)
                              and c.cdate + (interval '1 second' * tol_seconds)
    where c.smc <= 2
  ),
  cand_counts as (
    select contact_id, count(distinct source || '/' || medium) as cand_src
    from ga4_cand group by contact_id
  ),
  ga4_ranked as (
    select *, row_number() over (partition by contact_id order by delta asc) as rn
    from ga4_cand
  ),
  ga4_match as (
    select r.contact_id, r.source, r.medium, r.campaign, r.event_time_utc as matched_at,
           r.delta, cc.cand_src
    from ga4_ranked r
    join cand_counts cc using (contact_id)
    where r.rn = 1
  ),
  combined as (
    select cs.id as contact_id, cs.email, cs.cdate,
           cm.source as cm_source, cm.medium as cm_medium, cm.campaign as cm_campaign,
           cm.matched_at as cm_at,
           gm.source as gm_source, gm.medium as gm_medium, gm.campaign as gm_campaign,
           gm.matched_at as gm_at, gm.delta as gm_delta, gm.cand_src as gm_cand
    from contacts_scope cs
    left join calendly_match cm on cm.contact_id = cs.id
    left join ga4_match     gm on gm.contact_id = cs.id
  )
  select
    cb.contact_id,
    cb.email,
    cb.cdate,
    case when cb.cm_source is not null then cb.cm_source else cb.gm_source end,
    case when cb.cm_source is not null then cb.cm_medium else cb.gm_medium end,
    case when cb.cm_source is not null then cb.cm_campaign else cb.gm_campaign end,
    case when cb.cm_source is not null then 'calendly_email'
         when cb.gm_source is not null then 'ga4_time' end as match_method,
    case when cb.cm_source is not null then 'high'
         when cb.gm_source is not null then
           case when cb.gm_cand > 1
                then case when cb.gm_delta <= 90 then 'medium' else 'low' end
                else case when cb.gm_delta <= 90 then 'high'   else 'medium' end
           end
         end as confidence,
    case when cb.cm_source is null and cb.gm_source is not null then cb.gm_cand end as candidate_count,
    coalesce(cb.cm_at, cb.gm_at) as matched_at,
    case when cb.cm_source is null and cb.gm_source is not null then round(cb.gm_delta)::int end as time_delta_seconds,
    case
      when cb.cm_source is null and cb.gm_source is not null then cb.gm_source || ' / ' || cb.gm_medium
      when cb.cm_source is not null then (
        select ce.source || ' / ' || ce.medium
        from public.ga4_calendly_events_staging ce
        where ce.event_time_utc between coalesce(cb.cm_at, cb.cdate) - (interval '1 second' * tol_seconds)
                                    and coalesce(cb.cm_at, cb.cdate) + (interval '1 second' * tol_seconds)
        order by abs(extract(epoch from (coalesce(cb.cm_at, cb.cdate) - ce.event_time_utc))) asc
        limit 1
      )
    end as channel,
    now()
  from combined cb
  where cb.cm_source is not null or cb.gm_source is not null;  -- matched-only

  get diagnostics v_cs_rows = row_count;

  -- ===== 2. per-event audit (ga4_ac_event_matches) =====
  truncate public.ga4_ac_event_matches;

  insert into public.ga4_ac_event_matches
    (event_time, event_kind, event_name, source, medium, campaign, event_count,
     matched_contact_id, matched_email, match_method, time_delta_seconds)
  with contacts_scope as (
    select id, lower(email) as email, cdate,
           count(*) over (partition by date_trunc('minute', cdate)) as smc
    from public.activecampaign_contacts
    where cdate >= now() - (interval '1 day' * window_days)
      and email is not null and email <> ''
  ),
  pairs as (
    select g.ctid as gid, c.id as contact_id, c.email,
           abs(extract(epoch from (c.cdate - g.event_time_utc))) as delta
    from public.ga4_events_staging g
    join contacts_scope c
      on c.smc <= 2
     and g.event_time_utc between c.cdate - (interval '1 second' * tol_seconds)
                              and c.cdate + (interval '1 second' * tol_seconds)
  ),
  best as (
    select distinct on (gid) gid, contact_id, email, delta
    from pairs order by gid, delta asc
  )
  select g.event_time_utc, 'ga4_form', g.event_name, g.source, g.medium, g.campaign,
         g.event_count,
         b.contact_id, b.email,
         case when b.contact_id is not null then 'ga4_time' end,
         case when b.contact_id is not null then round(b.delta)::int end
  from public.ga4_events_staging g
  left join best b on b.gid = g.ctid;

  insert into public.ga4_ac_event_matches
    (event_time, event_kind, event_name, source, medium, campaign, event_count,
     matched_contact_id, matched_email, match_method, time_delta_seconds)
  select b.booking_created_at, 'calendly', b.event_name,
         coalesce(nullif(b.utm_source, ''), '(calendly)'),
         coalesce(nullif(b.utm_medium, ''), 'booking'),
         coalesce(nullif(b.utm_campaign, ''), b.event_name),
         1, c.id, lower(b.email),
         case when c.id is not null then 'calendly_email' end,
         null
  from public.calendly_bookings_staging b
  left join public.activecampaign_contacts c on lower(c.email) = lower(b.email);

  get diagnostics v_events = row_count;
  select count(*) into v_total from public.ga4_ac_contact_source;

  return jsonb_build_object(
    'contact_source_rows', v_cs_rows,
    'total_contact_source', v_total,
    'calendly_audit_rows', v_events,
    'window_days', window_days,
    'tol_seconds', tol_seconds,
    'rebuilt_at', now()
  );
end;
$$;
