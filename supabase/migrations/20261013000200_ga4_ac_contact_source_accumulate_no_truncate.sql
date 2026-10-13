-- Make public.ga4_ac_contact_source ACCUMULATE instead of truncate+rebuild, so the
-- Contact Sources page retains contacts older than the 60-day match window. Rows are
-- upserted (updated when the underlying AC deal changes, inserted when new) and never
-- deleted.
--
-- OWNERSHIP MODEL (important — prevents the AUD-vs-cents corruption now that gads rows
-- persist across runs):
--   * MATCHED rows (match_method IS NOT NULL): owned by section 1 (match upsert),
--     section 1b (deal_id link) and section 3 (denormalize from activecampaign_deals,
--     value in CENTS -> /100). Refreshed every run.
--   * GOOGLE-ADS rows (match_method IS NULL, deal_value already in AUD): owned solely
--     by section 4 (upsert from ac_google_ads_deals). Sections 1b and 3 are SCOPED to
--     match_method IS NOT NULL so they never touch — and never /100-corrupt — gads rows.
-- Section 4 excludes matched contacts and guards its DO UPDATE with
-- "WHERE match_method IS NULL" so it can never clobber a matched row.

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
  v_cs_rows     int;
  v_total       int;
  v_events      int;
  v_gads_rows   int;
  v_audit_total int;
begin
  -- ===== 1. per-contact rollup (matched-only, with channel) — ACCUMULATING (upsert, no truncate) =====
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
  where cb.cm_source is not null or cb.gm_source is not null  -- matched-only
  on conflict (contact_id) do update set
    email              = excluded.email,
    cdate              = excluded.cdate,
    source             = excluded.source,
    medium             = excluded.medium,
    campaign           = excluded.campaign,
    match_method       = excluded.match_method,
    confidence         = excluded.confidence,
    candidate_count    = excluded.candidate_count,
    matched_at         = excluded.matched_at,
    time_delta_seconds = excluded.time_delta_seconds,
    channel            = excluded.channel,
    updated_at         = now();

  get diagnostics v_cs_rows = row_count;

  -- ===== 1b. link deal_id (primary contact or organization match) — MATCHED rows only =====
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
    where gcs.match_method is not null  -- gads rows (match_method null) are owned by section 4
    order by
      gcs.contact_id,
      (ad.contact::text = ac.id::text) desc,
      ad.cdate desc nulls last
  )
  update public.ga4_ac_contact_source gcs
  set deal_id = rd.deal_id
  from ranked_deals rd
  where gcs.contact_id = rd.contact_id;

  -- ===== 2. per-event audit (ga4_ac_event_matches) — ACCUMULATING (upsert, no truncate) =====
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
  ),
  ga4_rows as (
    select g.event_time_utc as event_time, 'ga4_form'::text as event_kind, g.event_name,
           g.source, g.medium, g.campaign, g.event_count,
           b.contact_id as matched_contact_id, b.email as matched_email,
           case when b.contact_id is not null then 'ga4_time' end as match_method,
           case when b.contact_id is not null then round(b.delta)::int end as time_delta_seconds,
           g.page_path as conversion_link,
           g.ctid::text as src_ord
    from public.ga4_events_staging g
    left join best b on b.gid = g.ctid
  ),
  calendly_rows as (
    select b.booking_created_at as event_time, 'calendly'::text as event_kind, b.event_name,
           coalesce(nullif(b.utm_source, ''), '(calendly)') as source,
           coalesce(nullif(b.utm_medium, ''), 'booking')    as medium,
           coalesce(nullif(b.utm_campaign, ''), b.event_name) as campaign,
           1 as event_count,
           c.id as matched_contact_id, lower(b.email) as matched_email,
           case when c.id is not null then 'calendly_email' end as match_method,
           null::int as time_delta_seconds,
           (
             select ce.page_path
             from public.ga4_calendly_events_staging ce
             where ce.page_path is not null
               and ce.event_time_utc between b.booking_created_at - (interval '1 second' * tol_seconds)
                                         and b.booking_created_at + (interval '1 second' * tol_seconds)
             order by abs(extract(epoch from (b.booking_created_at - ce.event_time_utc))) asc
             limit 1
           ) as conversion_link,
           b.ctid::text as src_ord
    from public.calendly_bookings_staging b
    left join public.activecampaign_contacts c on lower(c.email) = lower(b.email)
  ),
  all_rows as (
    select * from ga4_rows
    union all
    select * from calendly_rows
  ),
  with_occ as (
    select *,
           row_number() over (
             partition by event_kind, (event_time at time zone 'UTC'),
                          event_name, source, medium, campaign, conversion_link
             order by src_ord
           ) as occurrence
    from all_rows
  ),
  keyed as (
    select *,
           md5(
             coalesce(event_kind,'') || '|' ||
             coalesce(to_char(event_time at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US'),'') || '|' ||
             coalesce(event_name,'') || '|' ||
             coalesce(source,'') || '|' ||
             coalesce(medium,'') || '|' ||
             coalesce(campaign,'') || '|' ||
             coalesce(conversion_link,'') || '|' ||
             occurrence::text
           ) as event_uid
    from with_occ
  )
  insert into public.ga4_ac_event_matches
    (event_uid, event_time, event_kind, event_name, source, medium, campaign, event_count,
     matched_contact_id, matched_email, match_method, time_delta_seconds, conversion_link, last_rebuilt_at)
  select event_uid, event_time, event_kind, event_name, source, medium, campaign, event_count,
         matched_contact_id, matched_email, match_method, time_delta_seconds, conversion_link, now()
  from keyed
  on conflict (event_uid) do update set
    event_time         = excluded.event_time,
    event_kind         = excluded.event_kind,
    event_name         = excluded.event_name,
    source             = excluded.source,
    medium             = excluded.medium,
    campaign           = excluded.campaign,
    event_count        = excluded.event_count,
    matched_contact_id = excluded.matched_contact_id,
    matched_email      = excluded.matched_email,
    match_method       = excluded.match_method,
    time_delta_seconds = excluded.time_delta_seconds,
    conversion_link    = excluded.conversion_link,
    last_rebuilt_at    = now();

  get diagnostics v_events = row_count;

  -- ===== 3. denormalize display columns onto ga4_ac_contact_source — MATCHED rows only =====
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
    where cs.match_method is not null
  )
  update public.ga4_ac_contact_source cs
  set conversion_link = b.conversion_link,
      conversion_action = b.conversion_action
  from best_ev b
  where b.contact_id = cs.contact_id;

  with deal_pick as (
    select cs.contact_id,
           dl.title as deal_title,
           dl.value as deal_value,
           dl.status as deal_status,
           dl.source_type
    from public.ga4_ac_contact_source cs
    left join lateral (
      select d.title, d.value / 100.0 as value,
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
    where cs.match_method is not null
  )
  update public.ga4_ac_contact_source cs
  set deal_title  = dp.deal_title,
      deal_value  = dp.deal_value,
      deal_status = dp.deal_status,
      source_type = dp.source_type
  from deal_pick dp
  where dp.contact_id = cs.contact_id;

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
    where cs.match_method is not null
  )
  update public.ga4_ac_contact_source cs
  set cpc = cp.cost_per_conversion
  from cpc_pick cp
  where cp.contact_id = cs.contact_id;

  -- ===== 4. Google Ads deal leads — UPSERT (accumulate; update when the gads deal changes) =====
  -- One row per contact (latest deal). Excludes matched contacts, and the DO UPDATE is
  -- guarded so it can never overwrite a matched row. ac_google_ads_deals.value is AUD.
  insert into public.ga4_ac_contact_source
    (contact_id, email, cdate, deal_id, deal_title, deal_value, deal_status,
     source_type, google_ads_ac_field, deal_source_ac_field, updated_at)
  select distinct on (d.contact_id)
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
    and d.contact_id is not null
    and d.contact_id::text not in (
      select contact_id::text from public.ga4_ac_contact_source where match_method is not null
    )
  order by d.contact_id, d.deal_cdate desc nulls last
  on conflict (contact_id) do update set
    email                = excluded.email,
    cdate                = coalesce(ga4_ac_contact_source.cdate, excluded.cdate),
    deal_id              = excluded.deal_id,
    deal_title           = excluded.deal_title,
    deal_value           = excluded.deal_value,
    deal_status          = excluded.deal_status,
    source_type          = excluded.source_type,
    google_ads_ac_field  = excluded.google_ads_ac_field,
    deal_source_ac_field = excluded.deal_source_ac_field,
    updated_at           = now()
  where ga4_ac_contact_source.match_method is null;  -- never clobber a matched row

  get diagnostics v_gads_rows = row_count;

  select count(*) into v_total       from public.ga4_ac_contact_source;
  select count(*) into v_audit_total from public.ga4_ac_event_matches;

  return jsonb_build_object(
    'contact_source_upserted', v_cs_rows,
    'google_ads_upserted', v_gads_rows,
    'total_contact_source_retained', v_total,
    'event_audit_upserted', v_events,
    'event_audit_retained_total', v_audit_total,
    'window_days', window_days,
    'tol_seconds', tol_seconds,
    'denormalized_columns', true,
    'accumulating', true,
    'rebuilt_at', now()
  );
end;
$$;
