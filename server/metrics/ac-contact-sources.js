// AC Contact Sources — per-contact inferred acquisition source.
//
// Reads a PRE-COMPUTED cache table, public.ga4_ac_contact_source, built by the
// google_ads_leads_tracking repo's scripts/map_ga4_ac.py: it maps GA4 form
// events (by timestamp) and Calendly bookings (by email/UTM) onto ActiveCampaign
// contacts. The dashboard does no GA4/Calendly calls at request time — it just
// SELECTs the table, so this stays fast. Plain SELECT → short cache is plenty.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'GA4 + Calendly → ActiveCampaign (Supabase cache)';

// channel = the GA4 session channel this lead came from ("source / medium", e.g.
// 'google / cpc', 'bing / cpc', 'google / organic', '(direct) / (none)',
// 'linkedin.com / referral', …; NULL for unmatched). Stored on the table: for
// GA4-time (form) contacts it's their own session source/medium; for Calendly
// contacts it's derived from the GA4 calendly_form_submit session channel
// (scripts/ad_search_source.py). The old source/medium columns are left untouched.
// conversionAction = the GA4 conversion event that matched this contact — looked up
// from the audit table ga4_ac_event_matches (Calendly matches are labelled
// calendly_form_submit; time-matched form contacts whose exact event can't be pinned
// fall back to "form_submit").
// link = the page path the conversion event fired on (conversion_link from ga4_ac_event_matches).
const SELECT = `
  SELECT
    cs.contact_id          AS "contactId",
    cs.email               AS "email",
    cs.cdate               AS "cdate",
    cs.channel             AS "channel",
    CASE
      WHEN cs.match_method IS NULL OR ev.conversion_link IS NULL THEN NULL
      WHEN cs.match_method = 'calendly_email' OR ev.event_kind = 'calendly' THEN 'calendly_form_submit'
      ELSE COALESCE(ev.event_name, 'form_submit')
    END                    AS "conversionAction",
    ev.conversion_link     AS "link",
    ev.conversion_link     AS "conversionLink",
    cs.source              AS "source",
    cs.medium              AS "medium",
    cs.campaign            AS "campaign",
    cs.match_method        AS "matchMethod",
    cs.confidence          AS "confidence",
    cs.candidate_count     AS "candidateCount",
    cs.matched_at          AS "matchedAt",
    cs.time_delta_seconds  AS "timeDeltaSeconds",
    cs.deal_id             AS "dealId",
    cs.google_ads_ac_field AS "googleAdsAcField",
    cs.deal_source_ac_field AS "dealSourceAcField",
    dl.title               AS "dealTitle",
    dl.value               AS "dealValue",
    dl.status              AS "dealStatus",
    dl.source_type         AS "sourceType",
    cpc.cost_per_conversion AS "cpc"
  FROM public.ga4_ac_contact_source cs
  LEFT JOIN LATERAL (
    SELECT em.event_name, em.conversion_link, em.event_kind
    FROM public.ga4_ac_event_matches em
    WHERE (
      em.matched_contact_id = cs.contact_id
      OR (cs.email IS NOT NULL AND em.matched_email = lower(cs.email))
      OR (
        cs.matched_at IS NOT NULL
        AND em.event_time = cs.matched_at
        AND (cs.source IS NULL OR em.source = cs.source)
        AND (cs.medium IS NULL OR em.medium = cs.medium)
      )
      OR (
        cs.matched_at IS NOT NULL
        AND abs(extract(epoch from (em.event_time - cs.matched_at))) <= 300
        AND (cs.source IS NULL OR em.source = cs.source)
        AND (cs.medium IS NULL OR em.medium = cs.medium)
      )
    )
    ORDER BY
      (em.matched_contact_id = cs.contact_id) DESC NULLS LAST,
      (cs.email IS NOT NULL AND em.matched_email = lower(cs.email)) DESC NULLS LAST,
      (cs.matched_at IS NOT NULL AND em.event_time = cs.matched_at) DESC NULLS LAST,
      (cs.source IS NOT NULL AND em.source = cs.source AND em.medium = cs.medium) DESC NULLS LAST,
      (em.conversion_link IS NOT NULL) DESC,
      abs(extract(epoch from (em.event_time - coalesce(cs.matched_at, cs.cdate)))) ASC,
      em.event_time DESC
    LIMIT 1
  ) ev ON true
  -- ActiveCampaign deal for this contact, joined by deal_id on ga4_ac_contact_source
  -- (with fallback to primary contact match d.contact = cs.contact_id).
  LEFT JOIN LATERAL (
    SELECT d.title, d.value / 100.0 AS value,  -- AC stores deal value in cents
           CASE d.status WHEN 1 THEN 'won' WHEN 2 THEN 'lost' ELSE 'open' END AS status,
           st.source_type  -- AC deal "Inbound/ Outbound?" field (Qualification Details)
    FROM public.activecampaign_deals d
    LEFT JOIN public.ac_deal_source_type st ON st.deal_id = d.id
    WHERE (cs.deal_id IS NOT NULL AND d.id::text = cs.deal_id::text)
       OR (cs.deal_id IS NULL AND d.contact::text = cs.contact_id::text)
    ORDER BY (cs.deal_id IS NOT NULL AND d.id::text = cs.deal_id::text) DESC,
             d.cdate DESC NULLS LAST
    LIMIT 1
  ) dl ON true
  -- Paid-ad cost for this contact's matched conversion (Google/Microsoft Ads,
  -- AUD). conversion_events_ac_matched holds GA4 cpc conversions matched to AC
  -- contacts; only the recent (~60d, GA4 retention) window carries a cost. Pick
  -- the best-attributed row (highest confidence, then nearest in time).
  LEFT JOIN LATERAL (
    SELECT m.cost_per_conversion
    FROM public.conversion_events_ac_matched m
    WHERE m.matched_contact_id = cs.contact_id
      AND m.cost_per_conversion IS NOT NULL
    ORDER BY (CASE m.match_confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END),
             m.delta_sec NULLS LAST
    LIMIT 1
  ) cpc ON true
  ORDER BY cs.cdate DESC NULLS LAST`;

const EXCLUDED_CONVERSION_LINKS = new Set([
  '/careers-seasonal/',
  '/executive-x/',
  '/careersph-based/',
  '/free-gift-opt-in/',
  '/leader-x-payment-gateway/',
  '/execx/',
  '/executive-x-payment-gateway/',
]);

function isExcludedConversionLink(link) {
  if (!link) return false;
  let s = String(link).trim().toLowerCase();
  if (!s) return false;
  try {
    if (s.startsWith('http://') || s.startsWith('https://')) {
      s = new URL(s).pathname.toLowerCase();
    }
  } catch (e) {}
  const path = (s.startsWith('/') ? s : '/' + s).split(/[?#\s]/)[0].replace(/\/+$/, '') + '/';
  return EXCLUDED_CONVERSION_LINKS.has(path);
}

function isExcludedRow(r) {
  if (!r) return false;
  const act = (r.conversionAction || '').trim().toLowerCase();
  if (act === 'free_gifts_opt_ins') return true;

  const ch = String(r.channel || '').trim().toLowerCase();
  const med = String(r.medium || '').trim().toLowerCase();
  const src = String(r.source || '').trim().toLowerCase();

  // Referrals
  if (med === 'referral' || ch.includes('referral') || src.includes('referral')) return true;

  // MS Teams
  if (ch.includes('teams') || src.includes('teams')) return true;

  // AC email campaign
  if (med === 'email' || ch.includes('email') || ch.includes('activecampaign') || src.includes('activecampaign')) return true;

  // Conversion link exclusion
  if (isExcludedConversionLink(r.link || r.conversionLink)) return true;

  return false;
}

export async function getAcContactSources() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      count: 0,
      rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
    };
  }

  const allRows = await q(SELECT);
  // Exclude free_gifts_opt_ins, channels in referrals, MS teams, AC email campaign,
  // and non-lead conversion links (/careers-seasonal/, /executive-x/, /careersph-based/, /free-gift-opt-in/)
  // from website display (data remains intact in DB)
  const rows = allRows.filter((r) => !isExcludedRow(r));
  const matched = rows.filter((r) => r.matchMethod && r.matchMethod !== 'unmatched').length;

  let status = 'live';
  let note = `${rows.length} contacts · ${matched} matched to a source.`;
  if (!rows.length) {
    status = 'pending';
    note = 'Contact-source cache is empty — run scripts/map_ga4_ac.py in the google_ads_leads_tracking repo to populate it.';
  }

  return {
    asOf: new Date().toISOString(),
    count: rows.length,
    rows: section(rows, { source: SRC, status, note }),
  };
}
