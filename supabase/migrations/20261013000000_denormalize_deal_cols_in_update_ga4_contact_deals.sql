-- Permanent fix for the Contact Sources "deal_id linked but deal_title blank" race.
--
-- Two jobs link a deal to a ga4_ac_contact_source row:
--   * rebuild_ga4_ac_matches()   (06:00 PH) — links deal_id AND denormalizes the
--     display columns (deal_title/value/status/source_type) in its step 3b.
--   * update_ga4_contact_deals() (07:00 PH, cron update-deals-daily-7am-pht) —
--     re-links deal_id with the same primary/org-match logic, but historically did
--     NOT denormalize. Because the activecampaign_deals mirror is refreshed by
--     sales-deals-sync at the SAME 06:00 PH slot as the rebuild, the rebuild often
--     reads the deals BEFORE the fresh ones land, misses them, and the 07:00
--     re-linker then sets deal_id — leaving deal_title/value/status NULL until the
--     next day's rebuild (which may race again).
--
-- Fix: make update_ga4_contact_deals() ALSO denormalize the display columns for the
-- rows whose deal_id resolves to an activecampaign_deals row. Mirrors step 3b of
-- rebuild_ga4_ac_matches(). Scoped to match_method IS NOT NULL so the Google-Ads-
-- appended rows (section 4 of the rebuild: match_method NULL, deal_value already in
-- AUD not cents) are never touched/clobbered.

create or replace function public.update_ga4_contact_deals()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- 1. re-link deal_id (primary contact or organization match) — unchanged.
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
  where gcs.contact_id = rd.contact_id
    and gcs.deal_id is distinct from rd.deal_id;

  -- 2. denormalize deal_title / deal_value / deal_status / source_type for matched
  --    rows whose deal_id resolves to an activecampaign_deals row. Mirrors step 3b
  --    of rebuild_ga4_ac_matches(). Scoped to match_method IS NOT NULL so the
  --    Google-Ads-appended rows (deal_value already in AUD) are left untouched.
  update public.ga4_ac_contact_source cs
  set deal_title  = d.title,
      deal_value  = d.value / 100.0,  -- activecampaign_deals.value is in cents
      deal_status = case d.status when 1 then 'won' when 2 then 'lost' else 'open' end,
      source_type = st.source_type
  from public.activecampaign_deals d
  left join public.ac_deal_source_type st on st.deal_id = d.id
  where cs.deal_id is not null
    and cs.match_method is not null
    and d.id::text = cs.deal_id::text;
end;
$function$;
