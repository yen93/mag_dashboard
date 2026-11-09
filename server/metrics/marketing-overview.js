// Marketing Overview — live KPI(s) for the Marketing Overview page.
//
// Two FY-aware headlines, both counting over THREE disjoint lead sources (the
// same population the Leads & Bookings "By source" table sums, so the two pages
// reconcile exactly):
//   • paid (ads) → paid-search-counted deals, public.roas_counted_deals (the same
//                  canonical view the ROAS tab counts). FY from the deal cdate.
//   • organic    → organic-search leads, public.ga4_ac_contact_source
//                  WHERE medium='organic'. FY from the contact cdate.
//   • indirect   → indirect / bureau deals, public.ac_indirect_deals (every AC
//                  deal whose "Deal Source?" = Indirect, 2021→present), EXCLUDING
//                  any deal already counted as paid (precedence paid > indirect,
//                  mirroring the ROI tab's marketing-revenue dedup). FY from cdate.
//
// The three buckets are disjoint (organic never overlaps paid/indirect by deal;
// indirect excludes paid deal_ids), so the total is a plain sum — no cross-source
// dedup needed, and it equals the Leads & Bookings by-source total.
//
//   "Keynote enquiries" = ALL deals/leads created in the FY (status-agnostic).
//   "Keynote bookings"  = only WON ones created in the FY
//                         (roas_counted_deals.status='won' / ga4 deal_status='won'
//                          / ac_indirect_deals.status=1).
//
// "Created in FY" = the deal's creation date, Australian FY (Jul–Jun, END-year:
// FY27 = Jul 2026 – Jun 2027) — the same FY framing the ROAS and ROI tabs use.
// LIVE, computed at request time. NB organic reads only within GA4's ~60-day
// retention window, so earlier FYs carry no organic rows (expected).

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC_ENQ =
  'Live (Supabase): count of deals/leads created per FY across three sources — ' +
  'paid (roas_counted_deals) + organic (ga4_ac_contact_source, medium=organic) + ' +
  'indirect/bureau (ac_indirect_deals, excl. paid deals).';
const SRC_BOOK =
  'Live (Supabase): count of WON deals/leads created per FY across three sources — ' +
  'paid (roas_counted_deals, status=won) + organic (ga4_ac_contact_source organic, ' +
  'deal_status=won) + indirect/bureau (ac_indirect_deals status=Won, excl. paid deals).';

// AU financial-year END year from a date column: calendar year + 1 if month >= July.
const FY = (col) =>
  `extract(year FROM ${col})::int + CASE WHEN extract(month FROM ${col}) >= 7 THEN 1 ELSE 0 END`;

// Shared three-bucket CTE. `roas` is the paid set (also used to exclude paid
// deal_ids from indirect); the three buckets are disjoint so counts just sum.
const BUCKETS_CTE = `
  WITH roas AS (
    SELECT deal_id::text AS deal_id, cdate, (status = 'won') AS won
    FROM public.roas_counted_deals WHERE cdate IS NOT NULL
  ),
  paid AS (
    SELECT 'ads'::text AS grp, cdate, won FROM roas
  ),
  organic AS (
    SELECT 'organic'::text AS grp, cdate, (deal_status = 'won') AS won
    FROM public.ga4_ac_contact_source
    WHERE medium = 'organic' AND cdate IS NOT NULL
  ),
  indirect AS (
    SELECT 'indirect'::text AS grp, cdate, (status = 1) AS won
    FROM public.ac_indirect_deals
    WHERE cdate IS NOT NULL AND deal_id IS NOT NULL
      AND deal_id::text NOT IN (SELECT deal_id FROM roas WHERE deal_id IS NOT NULL)
  ),
  u AS (
    SELECT * FROM paid UNION ALL SELECT * FROM organic UNION ALL SELECT * FROM indirect
  )`;

const OVERVIEW_SQL = `${BUCKETS_CTE}
  SELECT ${FY('cdate')} AS "fyEnd",
    count(*) FILTER (WHERE grp = 'ads')      AS ads,
    count(*) FILTER (WHERE grp = 'organic')  AS organic,
    count(*) FILTER (WHERE grp = 'indirect') AS indirect,
    count(*)                                 AS total,
    count(*) FILTER (WHERE grp = 'ads' AND won)      AS "adsWon",
    count(*) FILTER (WHERE grp = 'organic' AND won)  AS "organicWon",
    count(*) FILTER (WHERE grp = 'indirect' AND won) AS "indirectWon",
    count(*) FILTER (WHERE won)                       AS "totalWon"
  FROM u
  GROUP BY 1
  ORDER BY 1`;

// Per-MONTH version of the same three-bucket set (feeds the "Enquiries vs
// bookings" chart). The buckets are disjoint, so each row counts once by its
// creation month/FY and the monthly totals reconcile with the per-FY totals above.
const OVERVIEW_MONTH_SQL = `${BUCKETS_CTE}
  SELECT to_char(date_trunc('month', cdate), 'YYYY-MM') AS month,
    ${FY('cdate')} AS "fyEnd",
    count(*)                    AS enquiries,
    count(*) FILTER (WHERE won) AS bookings
  FROM u
  GROUP BY 1, 2
  ORDER BY 1`;

// Custom date-range variant — the SAME three-bucket set, filtered to an arbitrary
// [from,to] (inclusive) on each row's creation date. Day-level. $1=from, $2=to
// ('YYYY-MM-DD' or null). Buckets are disjoint, so total is a plain count.
const OVERVIEW_RANGE_SQL = `${BUCKETS_CTE}
  SELECT count(*)                                       AS total,
         count(*) FILTER (WHERE grp = 'ads')            AS ads,
         count(*) FILTER (WHERE grp = 'organic')        AS organic,
         count(*) FILTER (WHERE grp = 'indirect')       AS indirect,
         count(*) FILTER (WHERE won)                    AS "totalWon",
         count(*) FILTER (WHERE won AND grp = 'ads')      AS "adsWon",
         count(*) FILTER (WHERE won AND grp = 'organic')  AS "organicWon",
         count(*) FILTER (WHERE won AND grp = 'indirect') AS "indirectWon"
  FROM u
  WHERE ($1::date IS NULL OR cdate::date >= $1::date)
    AND ($2::date IS NULL OR cdate::date <= $2::date)`;

export async function getMarketingOverview(opts = {}) {
  const { from = null, to = null } = opts || {};
  if (!supabaseConfigured()) {
    const pending = (source) => ({
      byFy: [], byMonth: [], total: null,
      meta: { status: 'pending', source, note: 'Supabase not configured.' },
    });
    return { enquiries: pending(SRC_ENQ), bookings: pending(SRC_BOOK) };
  }

  const n = (v) => Number(v) || 0;
  const [rows, monthRows] = await Promise.all([q(OVERVIEW_SQL), q(OVERVIEW_MONTH_SQL)]);

  const enqByFy = rows.map((r) => ({
    fyEnd: n(r.fyEnd), fy: 'FY' + String(r.fyEnd).slice(-2),
    ads: n(r.ads), organic: n(r.organic), indirect: n(r.indirect), total: n(r.total),
  }));
  const bookByFy = rows.map((r) => ({
    fyEnd: n(r.fyEnd), fy: 'FY' + String(r.fyEnd).slice(-2),
    ads: n(r.adsWon), organic: n(r.organicWon), indirect: n(r.indirectWon), total: n(r.totalWon),
  }));

  // Monthly series (one { month:'YYYY-MM', fyEnd, total } per bucket), parallel to byFy.
  const enqByMonth = monthRows.map((r) => ({ month: r.month, fyEnd: n(r.fyEnd), total: n(r.enquiries) }));
  const bookByMonth = monthRows.map((r) => ({ month: r.month, fyEnd: n(r.fyEnd), total: n(r.bookings) }));

  // "All years" roll-up. Deals partition by their creation FY, so summing the
  // per-FY (already deal-distinct) totals is the all-years distinct count.
  const sum = (arr) => arr.reduce(
    (a, r) => ({ ads: a.ads + r.ads, organic: a.organic + r.organic, indirect: a.indirect + r.indirect, total: a.total + r.total }),
    { ads: 0, organic: 0, indirect: 0, total: 0 },
  );

  // Custom date-range roll-up (day-level), only when a range was requested.
  let enqRange = null, bookRange = null;
  if (from || to) {
    const rr = (await q(OVERVIEW_RANGE_SQL, [from, to]))[0] || {};
    enqRange = { from, to, ads: n(rr.ads), organic: n(rr.organic), indirect: n(rr.indirect), total: n(rr.total) };
    bookRange = { from, to, ads: n(rr.adsWon), organic: n(rr.organicWon), indirect: n(rr.indirectWon), total: n(rr.totalWon) };
  }

  return {
    enquiries: { byFy: enqByFy, byMonth: enqByMonth, total: sum(enqByFy), range: enqRange, meta: { status: 'live', source: SRC_ENQ, note: null } },
    bookings: { byFy: bookByFy, byMonth: bookByMonth, total: sum(bookByFy), range: bookRange, meta: { status: 'live', source: SRC_BOOK, note: null } },
  };
}
