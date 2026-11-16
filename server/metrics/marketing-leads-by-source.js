// Marketing — Leads & Bookings by source.
//
// Enquiries and bookings split across FOUR fixed lead sources, for the
// "Enquiries by source" stacked chart and the "By source" table on
// public/leads_bookings.html. LIVE, computed at request time from Supabase.
//
// Sources (all four draw into the same per-source × month union). The PAID bucket is
// built from THREE deduped sources — roas_counted_deals, ga4_ac_contact_source, and
// ac_google_ads_yes_deals — plus Organic (ga4) and Tailor/Bureau (ac_indirect_deals):
//
//   PAID — precedence ga4-cpc (platform) > roas > google-ads-flag:
//   • roas_counted_deals → the SAME view the ROAS tab counts, for ALL FYs:
//       'Paid Ads' before FY27 (one combined Google+Bing row), 'Google Ads' from FY27.
//       (FY27 roas deals already carried by a ga4 cpc row below are excluded here so the
//        Google/Bing split isn't lost — e.g. Tilray, a FY27 roas won deal with no ga4
//        cpc row, now shows as Google Ads instead of vanishing.)
//   • ga4_ac_contact_source cpc rows → FY27+ Google Ads / Bing Ads (the platform
//       authority), EXCLUDING non-keynote rows — conversion_link on a non-keynote funnel
//       page (careers / free-gift / Executive X / Leader X — see EXCLUDED_LINKS) OR a
//       free-gift opt-in conversion_action (same rule the GA4 & Ads Leads page uses).
//       platform read from `channel` ("bing / cpc"), fallback `source`. This also brings
//       in raw cpc leads that have no deal yet.
//   • ac_google_ads_yes_deals ("Google Ads?"=Yes) → only deals NOT already counted by
//       roas / ga4-cpc / indirect / organic (deduped via counted_ids). 'Paid Ads' <FY27,
//       'Google Ads' FY27+.
//
//   ALL FYs:
//   • Organic → ga4_ac_contact_source WHERE medium='organic' (FY27+ also drops
//               the EXCLUDED_LINKS pages; earlier FYs are left untouched).
//   • Tailor  → ac_indirect_deals WHERE is_tailor=true  (excl. paid/roas deals)
//   • Bureau  → ac_indirect_deals WHERE is_tailor=false (excl. paid/roas deals)
//
// Booking = won deal (roas status='won' / ga4 deal_status='won' / ac_indirect
// status=1 / ac_google_ads_yes_deals status=1). Tailor/Bureau EXCLUDE any deal already
// in the ROAS view (precedence paid > indirect). Month + Australian FY (END-year,
// Jul–Jun) from cdate. Because roas_counted_deals now feeds paid for ALL FYs (not just
// pre-FY27), the by-source total again RECONCILES with the Overview "Keynote
// enquiries/bookings" cards (marketing-overview.js imports GADS_YES_CTES + builds the
// identical paid population). Organic reads only within GA4's ~60-day retention.

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
  'Tailor/Bureau from ac_indirect_deals (excl. paid deals), plus ac_google_ads_yes_deals ' +
  '("Google Ads?"=Yes) not already counted (Paid Ads <FY27, Google Ads FY27+). FY27+ ga4 ' +
  'rows on certain non-keynote conversion pages or free-gift opt-ins are excluded. ' +
  'Booking = won deal; AU FY from cdate.';

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

// Shared CTEs for the paid bucket's dedup (spliced into every WITH below, AFTER the
// local `roas` CTE which they reference):
//   • ga_cpc_ids — FY27+ ga4_ac_contact_source cpc Google/Bing deal_ids. The ga4 cpc
//       arm keeps platform authority for FY27, so these are the deals the roas arm must
//       NOT re-count (it would otherwise lose the Google/Bing split).
//   • counted_ids — EVERY deal_id the paid/organic/indirect buckets already count:
//       roas (ALL FYs — roas_counted_deals is now an explicit paid source for every FY,
//       so FY27 roas deals like Tilray that have no ga4 cpc row still appear), ALL
//       ac_indirect_deals, the FY27 ga4 cpc rows (ga_cpc_ids), and organic ga4 rows.
//   • gy — ac_google_ads_yes_deals ("Google Ads?"=Yes) MINUS counted_ids, i.e. only the
//       Google-Ads-flagged deals no other source already has. Labelled 'Paid Ads'
//       before FY27 and 'Google Ads' from FY27 (the PAID_SPLIT_FY convention).
// Exported so marketing-overview.js builds the IDENTICAL paid population and the
// Overview "Keynote enquiries/bookings" cards stay reconciled with this by-source total.
export const GADS_YES_CTES = `
  ga_cpc_ids AS (
    SELECT deal_id::text AS deal_id FROM public.ga4_ac_contact_source
      WHERE deal_id IS NOT NULL AND cdate IS NOT NULL
        AND (${FY('cdate')}) >= ${PAID_SPLIT_FY}
        AND ${GA_IS_CPC} AND (${GA_PLATFORM}) IS NOT NULL AND ${GA_ROW_OK}
  ),
  counted_ids AS (
    SELECT deal_id::text AS deal_id FROM roas WHERE deal_id IS NOT NULL
    UNION
    SELECT deal_id::text FROM public.ac_indirect_deals WHERE deal_id IS NOT NULL
    UNION
    SELECT deal_id FROM ga_cpc_ids
    UNION
    SELECT deal_id::text FROM public.ga4_ac_contact_source
      WHERE deal_id IS NOT NULL AND cdate IS NOT NULL AND medium = 'organic'
        AND ( (${FY('cdate')}) < ${PAID_SPLIT_FY} OR ${GA_ROW_OK} )
  ),
  gy AS (
    SELECT deal_id::text AS deal_id, cdate, status, status_label, title,
           organization, contact_name, value_aud,
           (${FY('cdate')}) AS fy_end
      FROM public.ac_google_ads_yes_deals
      WHERE cdate IS NOT NULL
        AND deal_id::text NOT IN (SELECT deal_id FROM counted_ids)
  )`;

// Counts arm (source, cdate, won) for the by-source union.
export const GADS_SRC_ARM = `
    SELECT CASE WHEN fy_end >= ${PAID_SPLIT_FY} THEN 'Google Ads' ELSE 'Paid Ads' END AS source,
           cdate, (status = 1) AS won
      FROM gy`;

// Per-lead detail arm (full columns) for the "All leads" table.
export const GADS_LEADS_ARM = `
    SELECT CASE WHEN fy_end >= ${PAID_SPLIT_FY} THEN 'Google Ads' ELSE 'Paid Ads' END AS source, cdate,
           coalesce(nullif(organization, ''), contact_name) AS org, title,
           coalesce(status_label, '') AS status, (status = 1) AS won, value_aud AS value
      FROM gy`;

// The source UNION, shared by the per-FY payload and the custom-range variant.
// `roas` is the paid set (pre-FY27 paid bucket + the Tailor/Bureau exclusion list).
const SRC_CTE = `
  WITH roas AS (
    SELECT deal_id::text AS deal_id, cdate, (status = 'won') AS won,
           (${FY('cdate')}) AS fy_end
      FROM public.roas_counted_deals WHERE cdate IS NOT NULL
  ),
  ${GADS_YES_CTES},
  src AS (
    -- Paid from roas_counted_deals (the ROAS tab's view), ALL FYs: 'Paid Ads' before
    -- FY27, 'Google Ads' FY27+. FY27 roas deals already counted by the ga4 cpc arm below
    -- (which owns the Google/Bing platform) are excluded here to avoid double counting.
    SELECT CASE WHEN fy_end >= ${PAID_SPLIT_FY} THEN 'Google Ads' ELSE 'Paid Ads' END AS source,
           cdate, won
      FROM roas
      WHERE NOT (fy_end >= ${PAID_SPLIT_FY} AND deal_id IS NOT NULL
                 AND deal_id IN (SELECT deal_id FROM ga_cpc_ids))
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
    UNION ALL
    -- Google Ads flag (ac_google_ads_yes_deals) not already counted above:
    -- 'Paid Ads' before FY27, 'Google Ads' FY27+.
    ${GADS_SRC_ARM}
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
  ${GADS_YES_CTES},
  leads AS (
    -- Paid from roas_counted_deals, ALL FYs: 'Paid Ads' before FY27, 'Google Ads' FY27+.
    -- FY27 roas deals already counted by the ga4 cpc arm below are excluded here.
    SELECT CASE WHEN fy_end >= ${PAID_SPLIT_FY} THEN 'Google Ads' ELSE 'Paid Ads' END AS source, cdate,
           coalesce(nullif(org, ''), email) AS org, title,
           initcap(status) AS status, (status = 'won') AS won, value
      FROM roas
      WHERE NOT (fy_end >= ${PAID_SPLIT_FY} AND deal_id IS NOT NULL
                 AND deal_id IN (SELECT deal_id FROM ga_cpc_ids))
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
    UNION ALL
    -- Google Ads flag (ac_google_ads_yes_deals) not already counted above:
    -- 'Paid Ads' before FY27, 'Google Ads' FY27+.
    ${GADS_LEADS_ARM}
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
