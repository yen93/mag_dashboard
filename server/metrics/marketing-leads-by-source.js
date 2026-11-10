// Marketing — Leads & Bookings by source.
//
// Enquiries and bookings split across FOUR fixed lead sources, for the
// "Enquiries by source" stacked chart and the "By source" table on
// public/leads_bookings.html. LIVE, computed at request time from Supabase.
//
// Sources, with a DELIBERATE FY split for the paid + organic buckets:
//
//   EARLIER FYs (< FY27) — unchanged, from the ROAS-counted view:
//   • Paid Ads → public.roas_counted_deals (one combined Google+Bing row).
//
//   FY27 ONWARDS — paid + organic come straight from ga4_ac_contact_source
//   (so the page reconciles with the GA4 & Ads Leads tracker, NOT the Overview
//   card), EXCLUDING rows that aren't keynote enquiries — either conversion_link
//   is a non-keynote funnel page (careers / free-gift / Executive X / Leader X —
//   see EXCLUDED_LINKS) OR conversion_action is a free-gift opt-in
//   (free_gifts_opt_ins — same rule the GA4 & Ads Leads page uses; catches the
//   /free-gift-delivery-page/ variant that isn't in EXCLUDED_LINKS):
//   • Google Ads → ga4 cpc rows whose channel/source is google.
//   • Bing Ads   → ga4 cpc rows whose channel/source is bing.
//     (platform read from `channel`, e.g. "bing / cpc", which holds the real
//      platform even when `source` is "(calendly)"; fallback `source`.)
//
//   ALL FYs:
//   • Organic → ga4_ac_contact_source WHERE medium='organic' (FY27+ also drops
//               the EXCLUDED_LINKS pages; earlier FYs are left untouched).
//   • Tailor  → ac_indirect_deals WHERE is_tailor=true  (excl. paid deals)
//   • Bureau  → ac_indirect_deals WHERE is_tailor=false (excl. paid deals)
//
// Booking = won deal (roas status='won' / ga4 deal_status='won' / ac_indirect
// status=1). Tailor/Bureau EXCLUDE any deal already in the ROAS view (precedence
// paid > indirect). Month + Australian FY (END-year, Jul–Jun) from cdate.
// NB because FY27+ paid is now ga4-sourced, its total NO LONGER matches the
// Overview "Keynote enquiries/bookings" cards (those stay roas_counted_deals):
// Clover-audited paid deals with no ga4 row drop out, and ga4 raw cpc leads with
// no deal are added. Organic reads only within GA4's ~60-day retention.

import { q, supabaseConfigured } from '../providers/supabase.js';

// Master display order. FY27+ uses "Google Ads" / "Bing Ads"; earlier FYs use the
// single "Paid Ads". Each view only shows the sources actually present.
export const LEAD_SOURCES = ['Google Ads', 'Bing Ads', 'Paid Ads', 'Organic', 'Tailor', 'Bureau'];

// First AU FY (END-year) from which the paid bucket is split Google vs Bing and
// sourced from ga4_ac_contact_source (earlier FYs keep roas_counted_deals).
// Exported + reused by marketing-overview.js so the two stay in lockstep.
export const PAID_SPLIT_FY = 2027;

const SRC =
  'Live (Supabase): enquiries + bookings per source — paid is roas_counted_deals ' +
  'before FY27 (one "Paid Ads" row) and ga4_ac_contact_source cpc rows from FY27+ ' +
  '(split Google Ads / Bing Ads), Organic from ga4_ac_contact_source (medium=organic), ' +
  'Tailor/Bureau from ac_indirect_deals (excl. paid deals). FY27+ ga4 rows on certain ' +
  'non-keynote conversion pages or free-gift opt-ins are excluded. Booking = won deal; AU FY from cdate.';

// AU financial-year END year from a date column (calendar year + 1 if month >= July).
const FY = (col) =>
  `extract(year FROM ${col})::int + CASE WHEN extract(month FROM ${col}) >= 7 THEN 1 ELSE 0 END`;

// Ad platform from a ga4_ac_contact_source row — read from `channel` ("google / cpc",
// "bing / cpc"), which holds the real platform even when `source` is "(calendly)",
// falling back to `source`. NULL for anything that isn't Google/Bing.
export const GA_PLATFORM = `CASE
      WHEN lower(coalesce(channel, source, '')) LIKE '%bing%'   THEN 'Bing Ads'
      WHEN lower(coalesce(channel, source, '')) LIKE '%google%' THEN 'Google Ads'
      ELSE NULL END`;
// A paid (cost-per-click) ga4 row — `channel`/`source` carries "cpc".
export const GA_IS_CPC = `lower(coalesce(channel, source, '')) LIKE '%cpc%'`;

// Non-keynote conversion pages (careers / free-gift / Executive X / Leader X funnels):
// FY27+ ga4_ac_contact_source rows landing on one of these are NOT keynote enquiries,
// so they're dropped from the Google/Bing/Organic buckets.
const EXCLUDED_LINKS = [
  '/careers-seasonal/', '/executive-x/', '/careersph-based/', '/free-gift-opt-in/',
  '/leader-x-payment-gateway/', '/execx/', '/executive-x-payment-gateway/',
];
const EXCL_LINKS_SQL = EXCLUDED_LINKS.map((l) => `'${l.replace(/'/g, "''")}'`).join(', ');
// True when a ga4 row's conversion_link is NOT one of the excluded pages.
const GA_LINK_OK = `(conversion_link IS NULL OR conversion_link NOT IN (${EXCL_LINKS_SQL}))`;
// Free-gift opt-in leads aren't keynote enquiries — the GA4 & Ads Leads page drops them
// by conversion_action (ac-contact-sources.js), so FY27+ ga4 rows here do too. This also
// catches the /free-gift-delivery-page/ variant that isn't in EXCLUDED_LINKS.
const GA_ACTION_OK = `(lower(coalesce(conversion_action, '')) <> 'free_gifts_opt_ins')`;
// A ga4 row that still counts (not a non-keynote funnel page, not a free-gift opt-in).
export const GA_ROW_OK = `(${GA_LINK_OK} AND ${GA_ACTION_OK})`;

// The source UNION, shared by the per-FY payload and the custom-range variant.
// `roas` is the paid set (pre-FY27 paid bucket + the Tailor/Bureau exclusion list).
const SRC_CTE = `
  WITH roas AS (
    SELECT deal_id::text AS deal_id, cdate, (status = 'won') AS won,
           (${FY('cdate')}) AS fy_end
      FROM public.roas_counted_deals WHERE cdate IS NOT NULL
  ),
  src AS (
    -- Paid, earlier FYs (< FY27): one combined "Paid Ads" bucket from the ROAS view.
    SELECT 'Paid Ads'::text AS source, cdate, won
      FROM roas WHERE fy_end < ${PAID_SPLIT_FY}
    UNION ALL
    -- Paid, FY27+: Google Ads / Bing Ads from ga4_ac_contact_source cpc rows,
    -- dropping the non-keynote conversion pages.
    SELECT ${GA_PLATFORM} AS source, cdate, (deal_status = 'won')
      FROM public.ga4_ac_contact_source
      WHERE cdate IS NOT NULL
        AND (${FY('cdate')}) >= ${PAID_SPLIT_FY}
        AND ${GA_IS_CPC} AND (${GA_PLATFORM}) IS NOT NULL AND ${GA_ROW_OK}
    UNION ALL
    -- Organic (all FYs); FY27+ also drops the excluded conversion pages.
    SELECT 'Organic', cdate, (deal_status = 'won')
      FROM public.ga4_ac_contact_source
      WHERE medium = 'organic' AND cdate IS NOT NULL
        AND ( (${FY('cdate')}) < ${PAID_SPLIT_FY} OR ${GA_ROW_OK} )
    UNION ALL
    SELECT 'Tailor', cdate, (status = 1)
      FROM public.ac_indirect_deals
      WHERE is_tailor = true AND cdate IS NOT NULL
        AND deal_id::text NOT IN (SELECT deal_id FROM roas WHERE deal_id IS NOT NULL)
    UNION ALL
    SELECT 'Bureau', cdate, (status = 1)
      FROM public.ac_indirect_deals
      WHERE is_tailor = false AND cdate IS NOT NULL
        AND deal_id::text NOT IN (SELECT deal_id FROM roas WHERE deal_id IS NOT NULL)
  )`;

const BY_SOURCE_SQL = `${SRC_CTE}
  SELECT source,
    to_char(date_trunc('month', cdate), 'YYYY-MM') AS month,
    ${FY('cdate')} AS "fyEnd",
    count(*)                    AS enquiries,
    count(*) FILTER (WHERE won) AS bookings
  FROM src
  GROUP BY source, month, "fyEnd"
  ORDER BY month, source`;

// Custom date-range variant — same per-source × month rows, bounded to [from,to]
// (inclusive) on cdate at DAY level (an edge month shows only its in-range days).
// $1=from, $2=to ('YYYY-MM-DD' or null).
const RANGE_SQL = `${SRC_CTE}
  SELECT source,
    to_char(date_trunc('month', cdate), 'YYYY-MM') AS month,
    ${FY('cdate')} AS "fyEnd",
    count(*)                    AS enquiries,
    count(*) FILTER (WHERE won) AS bookings
  FROM src
  WHERE ($1::date IS NULL OR cdate::date >= $1::date)
    AND ($2::date IS NULL OR cdate::date <= $2::date)
  GROUP BY source, month, "fyEnd"
  ORDER BY month, source`;

// ---------------------------------------------------------------------------
// Per-lead detail — one row per individual deal/lead behind the counts above.
// Same four disjoint sources + dedup as SRC_CTE, but carrying each deal's
// date, org, title, status and value (AUD) for the "All leads" table.
const LEADS_CTE = `
  WITH roas AS (
    SELECT deal_id::text AS deal_id, cdate, status, org, title, email,
           coalesce(xero_engagement_fee, value) AS value,
           (${FY('cdate')}) AS fy_end
      FROM public.roas_counted_deals WHERE cdate IS NOT NULL
  ),
  leads AS (
    -- Paid, earlier FYs (< FY27): one combined "Paid Ads" row from the ROAS view.
    SELECT 'Paid Ads'::text AS source, cdate,
           coalesce(nullif(org, ''), email) AS org, title,
           initcap(status) AS status, (status = 'won') AS won, value
      FROM roas WHERE fy_end < ${PAID_SPLIT_FY}
    UNION ALL
    -- Paid, FY27+: Google Ads / Bing Ads from ga4_ac_contact_source cpc rows.
    SELECT ${GA_PLATFORM} AS source, cdate,
           email AS org, deal_title AS title,
           initcap(coalesce(deal_status, '')) AS status, (deal_status = 'won') AS won, deal_value AS value
      FROM public.ga4_ac_contact_source
      WHERE cdate IS NOT NULL
        AND (${FY('cdate')}) >= ${PAID_SPLIT_FY}
        AND ${GA_IS_CPC} AND (${GA_PLATFORM}) IS NOT NULL AND ${GA_ROW_OK}
    UNION ALL
    SELECT 'Organic', cdate,
           email AS org, deal_title AS title,
           initcap(coalesce(deal_status, '')) AS status, (deal_status = 'won') AS won, deal_value AS value
      FROM public.ga4_ac_contact_source
      WHERE medium = 'organic' AND cdate IS NOT NULL
        AND ( (${FY('cdate')}) < ${PAID_SPLIT_FY} OR ${GA_ROW_OK} )
    UNION ALL
    SELECT CASE WHEN is_tailor THEN 'Tailor' ELSE 'Bureau' END, cdate,
           coalesce(nullif(organization, ''), contact_name) AS org, title,
           coalesce(status_label, '') AS status, (status = 1) AS won, value_aud AS value
      FROM public.ac_indirect_deals
      WHERE cdate IS NOT NULL
        AND deal_id::text NOT IN (SELECT deal_id FROM roas WHERE deal_id IS NOT NULL)
  )`;

const LEADS_SELECT = `
  SELECT source,
    to_char(cdate, 'YYYY-MM-DD') AS date,
    to_char(date_trunc('month', cdate), 'YYYY-MM') AS month,
    ${FY('cdate')} AS "fyEnd",
    org, title, status, won, coalesce(value, 0) AS value
  FROM leads`;

const LEADS_SQL = `${LEADS_CTE}${LEADS_SELECT} ORDER BY cdate DESC, source`;

// Day-level custom-range variant. $1=from, $2=to ('YYYY-MM-DD' or null).
const LEADS_RANGE_SQL = `${LEADS_CTE}${LEADS_SELECT}
  WHERE ($1::date IS NULL OR cdate::date >= $1::date)
    AND ($2::date IS NULL OR cdate::date <= $2::date)
  ORDER BY cdate DESC, source`;

const toLead = (r) => ({
  source: r.source, date: r.date, month: r.month, fyEnd: Number(r.fyEnd) || 0,
  org: r.org || '', title: r.title || '', status: r.status || '',
  won: r.won === true, value: Number(r.value) || 0,
});

export async function getMarketingLeadsBySource(opts = {}) {
  const { from = null, to = null } = opts || {};
  if (!supabaseConfigured()) {
    return {
      sources: LEAD_SOURCES, data: [], leads: [],
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' },
    };
  }
  const n = (v) => Number(v) || 0;
  const toRow = (r) => ({
    source: r.source, month: r.month, fyEnd: n(r.fyEnd),
    enquiries: n(r.enquiries), bookings: n(r.bookings),
  });
  const [rows, leadRows] = await Promise.all([q(BY_SOURCE_SQL), q(LEADS_SQL)]);
  const data = rows.map(toRow);
  const leads = leadRows.map(toLead);

  // Custom date-range rows (day-level), only when a range was requested.
  let range = null;
  if (from || to) {
    const [rRows, rLeads] = await Promise.all([q(RANGE_SQL, [from, to]), q(LEADS_RANGE_SQL, [from, to])]);
    range = { from, to, data: rRows.map(toRow), leads: rLeads.map(toLead) };
  }
  return { sources: LEAD_SOURCES, data, leads, range, meta: { status: 'live', source: SRC, note: null } };
}
