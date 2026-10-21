// AC Contact Sources — per-contact inferred acquisition source.
//
// Reads a PRE-COMPUTED cache table, public.ga4_ac_contact_source, rebuilt daily by
// the contact-sources-sync edge-function orchestrator (rebuild_ga4_ac_matches() maps
// GA4 form events by timestamp and Calendly bookings by email/UTM onto ActiveCampaign
// contacts, and denormalizes every display column onto the table). The dashboard does
// no GA4/Calendly calls and no joins at request time — it SELECTs this one table, so
// this stays fast. Plain single-table SELECT → short cache is plenty.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'GA4 + Calendly → ActiveCampaign (Supabase cache)';

// Single-table read. Every display column is now stored directly on
// public.ga4_ac_contact_source — the rebuild_ga4_ac_matches() function denormalizes
// them each rebuild (see migration 20261009000000_contact_source_denormalized_columns.sql),
// so there are no joins here. The columns this page reads:
//   fy / cal_yr       — fiscal year ("FY26") and calendar year, generated from cdate.
//   jc_manual_tag     — mag_gads_direct_inbound_lead_source.jc_final_attr (by deal_id).
//   channel           — GA4 session channel ("source / medium", NULL for unmatched).
//   conversionAction  — the matched GA4 conversion event (calendly_form_submit for
//                       Calendly; "form_submit" fallback for time-matched forms).
//   conversion_link   — the page path the conversion event fired on (link / conversionLink).
//   deal_*            — the AC deal for the contact (value already in AUD, status mapped).
//   source_type       — AC deal "Inbound/ Outbound?" field.
//   cpc               — paid-ad cost per conversion (AUD), when known.
//   engagement_fee / other_fees / gst / amount_total
//                     — Xero invoice breakdown for the deal (AUD), from
//                       mag_gads_direct_inbound_lead_source by deal_id (shown behind the
//                       page's "Show Xero $" toggle). NULL until the deal is invoiced.
const SELECT = `
  SELECT
    cs.contact_id          AS "contactId",
    cs.email               AS "email",
    cs.cdate               AS "cdate",
    cs.fy                  AS "fy",
    cs.cal_yr             AS "calYr",
    -- Effective JC tag: a manual review decision (ga4cs_jc_manual_review) wins over the
    -- auto-derived cs.jc_manual_tag. jcReviewed = a manual review row exists (decision may
    -- be NULL = reviewed-negative). jcSetBy/jcSetAt power the cell tooltip.
    CASE WHEN r.contact_id IS NOT NULL THEN r.decision ELSE cs.jc_manual_tag END AS "jcManualTag",
    (r.contact_id IS NOT NULL) AS "jcReviewed",
    r.set_by               AS "jcSetBy",
    r.updated_at           AS "jcSetAt",
    cs.channel             AS "channel",
    cs.conversion_action   AS "conversionAction",
    cs.conversion_link     AS "link",
    cs.conversion_link     AS "conversionLink",
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
    cs.deal_title          AS "dealTitle",
    cs.deal_value          AS "dealValue",
    cs.deal_status         AS "dealStatus",
    cs.source_type         AS "sourceType",
    cs.cpc                 AS "cpc",
    cs.engagement_fee      AS "engagementFee",
    cs.other_fees          AS "otherFees",
    cs.gst                 AS "gst",
    cs.amount_total        AS "amountTotal"
  FROM public.ga4_ac_contact_source cs
  LEFT JOIN public.ga4cs_jc_manual_review r ON r.contact_id = cs.contact_id
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

// KEEP IDENTICAL to isExcludedRow() in public/ac_contact_sources.html.
// A row is SHOWN iff: JC manual tag (always), OR not a free-gift opt-in AND not an
// excluded conversion link AND (channel looks organic/cpc OR google_ads_ac_field='Yes').
// DELIBERATE DIVERGENCE from CONTACT_SOURCE_SHOWN in ../lib/sql.js: that predicate
// (used by ROAS) intentionally OMITS the google_ads_ac_field='Yes' branch, so showing
// these rows on the page/API does NOT change ROAS counts.
const ORGANIC_OR_CPC = /cpc|organic/i;
function isExcludedRow(r) {
  if (!r) return false;
  // JC-tagged rows (mag_gads jc_final_attr, e.g. "Could be SEO or Paid Ad") are part of
  // the manual ROAS audit and must ALWAYS be shown — exempt from every exclusion below.
  if (r.jcManualTag) return false;

  // Safety blacklist: free-gift opt-ins and non-lead conversion links.
  const act = (r.conversionAction || '').trim().toLowerCase();
  if (act === 'free_gifts_opt_ins') return true;
  if (isExcludedConversionLink(r.link || r.conversionLink)) return true;

  // Show organic/cpc channels, plus AC "Google Ads?"=Yes rows (even with no GA4
  // channel — e.g. aged out of the ~60-day window); hide everything else.
  if (ORGANIC_OR_CPC.test(String(r.channel || ''))) return false;
  if (String(r.googleAdsAcField || '').trim().toLowerCase() === 'yes') return false;
  return true;
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
    note = 'Contact-source cache is empty — run the contact-sources-sync edge function (or wait for its daily 06:00 PH run) to populate it.';
  }

  return {
    asOf: new Date().toISOString(),
    count: rows.length,
    rows: section(rows, { source: SRC, status, note }),
  };
}
