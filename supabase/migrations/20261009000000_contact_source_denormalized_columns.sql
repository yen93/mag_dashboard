-- Contact Sources — denormalize the display columns onto ga4_ac_contact_source.
--
-- The "Contact Sources" tab (public/ac_contact_sources.html, backed by
-- server/metrics/ac-contact-sources.js) shows columns that were NOT stored on
-- public.ga4_ac_contact_source — they were computed at request time by joining
-- ga4_ac_event_matches, activecampaign_deals (+ ac_deal_source_type) and
-- conversion_events_ac_matched. This migration:
--   1. Adds those columns to the table (nothing dropped; all nullable).
--   2. Extends rebuild_ga4_ac_matches() to POPULATE them each rebuild, mirroring
--      the exact join/CASE logic in ac-contact-sources.js, so the table contains
--      every column the page shows and manually-inserted rows can carry them too.
--
-- The dashboard query is unchanged: its live joins stay authoritative, and these
-- denormalized columns are a per-rebuild snapshot. Columns whose source table has
-- no matching row simply stay NULL — the rebuild never hard-fails on them.

-- ===== new columns (page columns not already stored on the table) =====
alter table public.ga4_ac_contact_source add column if not exists conversion_action text;
alter table public.ga4_ac_contact_source add column if not exists conversion_link   text;
alter table public.ga4_ac_contact_source add column if not exists deal_title        text;
alter table public.ga4_ac_contact_source add column if not exists deal_value        numeric;
alter table public.ga4_ac_contact_source add column if not exists deal_status       text;
alter table public.ga4_ac_contact_source add column if not exists source_type       text;
alter table public.ga4_ac_contact_source add column if not exists cpc               numeric;

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
  v_cs_rows   int;
  v_total     int;
  v_events    int;
  v_gads_rows int;
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

  -- ===== 3. denormalize the display columns onto ga4_ac_contact_source =====
  -- Mirrors the LATERAL joins in server/metrics/ac-contact-sources.js so the
  -- table itself carries every column the Contact Sources tab shows. contact_id
  -- is one row per contact in this table, so each CTE joins back by contact_id.

  -- 3a. conversion_link + conversion_action (from the best matched GA4/Calendly event)
  with best_ev as (
    select cs.contact_id,
           ev.conversion_link,
           case
             when cs.match_method is null or ev.conversion_link is null then null
             when cs.match_method = 'calendly_email' or ev.event_kind = 'calendly' then 'calendly_form_submit'
             else coalesce(ev.event_name, 'form_submit')
           end as conversion_action
    from public.ga4_ac_contact_source cs
    left join lateral (
      select em.event_name, em.conversion_link, em.event_kind
      from public.ga4_ac_event_matches em
      where (
        em.matched_contact_id = cs.contact_id
        or (cs.email is not null and em.matched_email = lower(cs.email))
        or (
          cs.matched_at is not null
          and em.event_time = cs.matched_at
          and (cs.source is null or em.source = cs.source)
          and (cs.medium is null or em.medium = cs.medium)
        )
        or (
          cs.matched_at is not null
          and abs(extract(epoch from (em.event_time - cs.matched_at))) <= 300
          and (cs.source is null or em.source = cs.source)
          and (cs.medium is null or em.medium = cs.medium)
        )
      )
      order by
        (em.matched_contact_id = cs.contact_id) desc nulls last,
        (cs.email is not null and em.matched_email = lower(cs.email)) desc nulls last,
        (cs.matched_at is not null and em.event_time = cs.matched_at) desc nulls last,
        (cs.source is not null and em.source = cs.source and em.medium = cs.medium) desc nulls last,
        (em.conversion_link is not null) desc,
        abs(extract(epoch from (em.event_time - coalesce(cs.matched_at, cs.cdate)))) asc,
        em.event_time desc
      limit 1
    ) ev on true
  )
  update public.ga4_ac_contact_source cs
  set conversion_link = b.conversion_link,
      conversion_action = b.conversion_action
  from best_ev b
  where b.contact_id = cs.contact_id;

  -- 3b. deal_title / deal_value / deal_status / source_type (AC deal for this contact)
  with deal_pick as (
    select cs.contact_id,
           dl.title as deal_title,
           dl.value as deal_value,
           dl.status as deal_status,
           dl.source_type
    from public.ga4_ac_contact_source cs
    left join lateral (
      select d.title, d.value / 100.0 as value,  -- AC stores deal value in cents
             case d.status when 1 then 'won' when 2 then 'lost' else 'open' end as status,
             st.source_type
      from public.activecampaign_deals d
      left join public.ac_deal_source_type st on st.deal_id = d.id
      where (cs.deal_id is not null and d.id::text = cs.deal_id::text)
         or (cs.deal_id is null and d.contact::text = cs.contact_id::text)
      order by (cs.deal_id is not null and d.id::text = cs.deal_id::text) desc,
               d.cdate desc nulls last
      limit 1
    ) dl on true
  )
  update public.ga4_ac_contact_source cs
  set deal_title  = dp.deal_title,
      deal_value  = dp.deal_value,
      deal_status = dp.deal_status,
      source_type = dp.source_type
  from deal_pick dp
  where dp.contact_id = cs.contact_id;

  -- 3c. cpc (paid-ad cost per conversion for this contact's matched conversion)
  with cpc_pick as (
    select cs.contact_id, c.cost_per_conversion
    from public.ga4_ac_contact_source cs
    left join lateral (
      select m.cost_per_conversion
      from public.conversion_events_ac_matched m
      where m.matched_contact_id = cs.contact_id
        and m.cost_per_conversion is not null
      order by (case m.match_confidence when 'high' then 0 when 'medium' then 1 else 2 end),
               m.delta_sec nulls last
      limit 1
    ) c on true
  )
  update public.ga4_ac_contact_source cs
  set cpc = cp.cost_per_conversion
  from cpc_pick cp
  where cp.contact_id = cs.contact_id;

  -- ===== 4. append Google Ads deal leads not matched to GA4/Calendly =====
  -- The primary contact of each public.ac_google_ads_deals deal whose email is not
  -- already in the table. These have no GA4/Calendly session, so all GA4/match
  -- columns are left NULL; deal + source fields come from the AC deal data already
  -- mirrored in Supabase (cdate from the AC contact when available, else the deal).
  -- One row per contact (latest deal wins). NB: ac_google_ads_deals is refreshed by
  -- the fire-and-forget ac-google-ads-deals-sync step, so a brand-new Google Ads
  -- lead appears here within ~1 day (the rebuild reads the prior run's snapshot).
  insert into public.ga4_ac_contact_source
    (contact_id, email, cdate, deal_id, deal_title, deal_value, deal_status,
     source_type, google_ads_ac_field, deal_source_ac_field, updated_at)
  select distinct on (lower(d.contact_email))
    d.contact_id,
    lower(d.contact_email),
    coalesce(ac.cdate, d.deal_cdate),
    d.deal_id,
    d.title,
    d.value,                 -- ac_google_ads_deals.value is already AUD (not cents)
    d.status,                -- already 'won' / 'lost' / 'open'
    d.source_type,
    d.google_ads_field,
    d.deal_source_field,
    now()
  from public.ac_google_ads_deals d
  left join public.activecampaign_contacts ac on ac.id::text = d.contact_id::text
  where d.contact_email is not null
    and d.contact_email <> ''
    and lower(d.contact_email) not in (
      select email from public.ga4_ac_contact_source where email is not null
    )
  order by lower(d.contact_email), d.deal_cdate desc nulls last;

  get diagnostics v_gads_rows = row_count;

  select count(*) into v_total from public.ga4_ac_contact_source;

  return jsonb_build_object(
    'contact_source_rows', v_cs_rows,
    'google_ads_appended_rows', v_gads_rows,
    'total_contact_source', v_total,
    'calendly_audit_rows', v_events,
    'window_days', window_days,
    'tol_seconds', tol_seconds,
    'denormalized_columns', true,
    'rebuilt_at', now()
  );
end;
$$;
