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
const SELECT = `
  SELECT
    cs.contact_id          AS "contactId",
    cs.email               AS "email",
    cs.cdate               AS "cdate",
    cs.channel             AS "channel",
    CASE
      WHEN cs.match_method = 'calendly_email' THEN 'calendly_form_submit'
      WHEN cs.match_method = 'ga4_time'       THEN COALESCE(ev.event_name, 'form_submit')
      ELSE NULL
    END                    AS "conversionAction",
    cs.source              AS "source",
    cs.medium              AS "medium",
    cs.campaign            AS "campaign",
    cs.match_method        AS "matchMethod",
    cs.confidence          AS "confidence",
    cs.candidate_count     AS "candidateCount",
    cs.matched_at          AS "matchedAt",
    cs.time_delta_seconds  AS "timeDeltaSeconds"
  FROM public.ga4_ac_contact_source cs
  LEFT JOIN LATERAL (
    SELECT em.event_name
    FROM public.ga4_ac_event_matches em
    WHERE em.matched_contact_id = cs.contact_id
      AND em.event_time = cs.matched_at
    LIMIT 1
  ) ev ON true
  ORDER BY cs.cdate DESC NULLS LAST`;

export async function getAcContactSources() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      count: 0,
      rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
    };
  }

  const rows = await q(SELECT);
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
