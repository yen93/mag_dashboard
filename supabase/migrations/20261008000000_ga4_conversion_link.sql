-- GA4 & Ads Leads Tracking — capture the page each conversion event fired on.
--
-- Adds:
--   * public.ga4_ac_event_matches.conversion_link — the page path the event fired on
--     (e.g. '/careers-seasonal/', '/executive-x/', '/free-consult/', '/ (home)').
--   * page_path on the two GA4 staging tables — loaded by the ga4-ads-leads-sync edge
--     function from the GA4 Data API `pagePath` dimension.
--
-- conversion_link source per event_kind:
--   ga4_form  -> the GA4 event's own pagePath.
--   calendly  -> pagePath of the nearest GA4 calendly_form_submit event (± tol_seconds of
--                the booking), since the Calendly API doesn't report the host page.
--
-- Backward compatible: all new columns are nullable, so an older edge-function build
-- that doesn't send page_path still loads + rebuilds fine (conversion_link = NULL).
-- No existing rows are deleted beyond the normal full rebuild these tables already do.

alter table public.ga4_ac_contact_source add column if not exists deal_id text;
alter table public.ga4_ac_event_matches  add column if not exists conversion_link text;
alter table public.ga4_events_staging          add column if not exists page_path text;
alter table public.ga4_calendly_events_staging add column if not exists page_path text;

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

  -- ===== 1b. link deal_id (primary contact or organization match) =====
  with ranked_deals as (
    select distinct on (gcs.contact_id)
      gcs.contact_id,
      ad.id as deal_id
    from public.ga4_ac_contact_source gcs
    join public.activecampaign_contacts ac 
      on ac.id::text = gcs.contact_id::text
    join public.activecampaign_deals ad 
      on (
        ad.contact::text = ac.id::text
        or (
          ac.orgid is not null
          and ac.orgid not in ('', '0')
          and ac.orgid::text = ad.organization::text
        )
      )
    order by
      gcs.contact_id,
      (ad.contact::text = ac.id::text) desc,
      ad.cdate desc nulls last
  )
  update public.ga4_ac_contact_source gcs
  set deal_id = rd.deal_id
  from ranked_deals rd
  where gcs.contact_id = rd.contact_id;

  -- ===== 2. per-event audit (ga4_ac_event_matches) =====
  truncate public.ga4_ac_event_matches;

  insert into public.ga4_ac_event_matches
    (event_time, event_kind, event_name, source, medium, campaign, event_count,
     matched_contact_id, matched_email, match_method, time_delta_seconds, conversion_link)
  with contacts_scope as (
    select id, lower(email) as email, cdate,
           count(*) over (partition by date_trunc('minute', cdate)) as smc
    from public.activecampaign_contacts
    where cdate >= now() - (interval '1 day' * window_days)
      and email is not null and email <> ''
  ),
  pairs as (
    select g.ctid as gid, c.id as contact_id, c.email,
           abs(extract(epoch from (c.cdate - g.event_time_utc))) as delta,
           case when cs.contact_id is not null and cs.matched_at = g.event_time_utc then 0 else 1 end as cs_priority
    from public.ga4_events_staging g
    join contacts_scope c
      on c.smc <= 2
     and g.event_time_utc between c.cdate - (interval '1 second' * tol_seconds)
                              and c.cdate + (interval '1 second' * tol_seconds)
    left join public.ga4_ac_contact_source cs
      on cs.contact_id = c.id
  ),
  best as (
    select distinct on (gid) gid, contact_id, email, delta
    from pairs order by gid, cs_priority asc, delta asc
  )
  select g.event_time_utc, 'ga4_form', g.event_name, g.source, g.medium, g.campaign,
         g.event_count,
         b.contact_id, b.email,
         case when b.contact_id is not null then 'ga4_time' end,
         case when b.contact_id is not null then round(b.delta)::int end,
         g.page_path
  from public.ga4_events_staging g
  left join best b on b.gid = g.ctid;

  insert into public.ga4_ac_event_matches
    (event_time, event_kind, event_name, source, medium, campaign, event_count,
     matched_contact_id, matched_email, match_method, time_delta_seconds, conversion_link)
  select b.booking_created_at, 'calendly', b.event_name,
         coalesce(nullif(b.utm_source, ''), '(calendly)'),
         coalesce(nullif(b.utm_medium, ''), 'booking'),
         coalesce(nullif(b.utm_campaign, ''), b.event_name),
         1, c.id, lower(b.email),
         case when c.id is not null then 'calendly_email' end,
         null,
         (
           select ce.page_path
           from public.ga4_calendly_events_staging ce
           where ce.page_path is not null
             and ce.event_time_utc between b.booking_created_at - (interval '1 second' * tol_seconds)
                                       and b.booking_created_at + (interval '1 second' * tol_seconds)
           order by abs(extract(epoch from (b.booking_created_at - ce.event_time_utc))) asc
           limit 1
         )
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
