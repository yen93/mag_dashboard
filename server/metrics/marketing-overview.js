// Marketing Overview — live KPI(s) for the Marketing Overview page.
//
// Two FY-aware headlines, both counting ActiveCampaign deals across two sources
// (deduped by deal, so a deal in both sources counts once):
//   • ads      → paid-search-counted deals, public.roas_counted_deals (the same
//                canonical view the ROAS tab counts). FY from the deal cdate.
//   • indirect → indirect / bureau deals, public.ac_indirect_deals (every AC deal
//                whose "Deal Source?" = Indirect, 2021→present). FY from cdate.
//
//   "Keynote enquiries" = ALL deals created in the FY (status-agnostic).
//   "Keynote bookings"  = only WON deals created in the FY
//                         (roas_counted_deals.status='won' / ac_indirect_deals.status=1).
//
// "Created in FY" = the deal's creation date, Australian FY (Jul–Jun, END-year:
// FY27 = Jul 2026 – Jun 2027) — the same FY framing the ROAS and ROI tabs use.
// LIVE, computed at request time.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC_ENQ =
  'Live (Supabase): count of deals created per FY across two sources — ads ' +
  '(roas_counted_deals) + indirect/bureau (ac_indirect_deals) — deduped by deal.';
const SRC_BOOK =
  'Live (Supabase): count of WON deals created per FY across two sources — ads ' +
  '(roas_counted_deals, status=won) + indirect/bureau (ac_indirect_deals, status=Won) — deduped by deal.';

// AU financial-year END year from a date column: calendar year + 1 if month >= July.
const FY = (col) =>
  `extract(year FROM ${col})::int + CASE WHEN extract(month FROM ${col}) >= 7 THEN 1 ELSE 0 END`;

const OVERVIEW_SQL = `
  WITH ads AS (
    SELECT DISTINCT deal_id::text AS deal_id, ${FY('cdate')} AS fy_end, 'ads' AS grp,
      (status = 'won') AS won
    FROM public.roas_counted_deals WHERE cdate IS NOT NULL AND deal_id IS NOT NULL
  ),
  indirect AS (
    SELECT DISTINCT deal_id::text AS deal_id, ${FY('cdate')} AS fy_end, 'indirect' AS grp,
      (status = 1) AS won
    FROM public.ac_indirect_deals WHERE cdate IS NOT NULL AND deal_id IS NOT NULL
  ),
  u AS (
    SELECT * FROM ads UNION ALL SELECT * FROM indirect
  )
  SELECT fy_end AS "fyEnd",
    count(*) FILTER (WHERE grp = 'ads')      AS ads,
    count(*) FILTER (WHERE grp = 'indirect') AS indirect,
    count(DISTINCT deal_id)                  AS total,
    count(*) FILTER (WHERE grp = 'ads' AND won)      AS "adsWon",
    count(*) FILTER (WHERE grp = 'indirect' AND won) AS "indirectWon",
    count(DISTINCT deal_id) FILTER (WHERE won)       AS "totalWon"
  FROM u
  GROUP BY fy_end
  ORDER BY fy_end`;

// Per-MONTH version of the same deduped-deal set (feeds the "Enquiries vs bookings"
// chart). Each deal collapses to ONE row (its creation month/FY, and whether it is
// won in any source), so counts reconcile with the per-FY totals above.
const OVERVIEW_MONTH_SQL = `
  WITH ads AS (
    SELECT DISTINCT deal_id::text AS deal_id, cdate, ${FY('cdate')} AS fy_end,
      (status = 'won') AS won
    FROM public.roas_counted_deals WHERE cdate IS NOT NULL AND deal_id IS NOT NULL
  ),
  indirect AS (
    SELECT DISTINCT deal_id::text AS deal_id, cdate, ${FY('cdate')} AS fy_end,
      (status = 1) AS won
    FROM public.ac_indirect_deals WHERE cdate IS NOT NULL AND deal_id IS NOT NULL
  ),
  u AS ( SELECT * FROM ads UNION ALL SELECT * FROM indirect ),
  dedup AS (
    SELECT deal_id,
      to_char(date_trunc('month', min(cdate)), 'YYYY-MM') AS month,
      max(fy_end) AS fy_end,
      bool_or(won) AS won
    FROM u GROUP BY deal_id
  )
  SELECT month, max(fy_end) AS "fyEnd",
    count(*)                    AS enquiries,
    count(*) FILTER (WHERE won) AS bookings
  FROM dedup
  GROUP BY month
  ORDER BY month`;

export async function getMarketingOverview() {
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
    ads: n(r.ads), indirect: n(r.indirect), total: n(r.total),
  }));
  const bookByFy = rows.map((r) => ({
    fyEnd: n(r.fyEnd), fy: 'FY' + String(r.fyEnd).slice(-2),
    ads: n(r.adsWon), indirect: n(r.indirectWon), total: n(r.totalWon),
  }));

  // Monthly series (one { month:'YYYY-MM', fyEnd, total } per bucket), parallel to byFy.
  const enqByMonth = monthRows.map((r) => ({ month: r.month, fyEnd: n(r.fyEnd), total: n(r.enquiries) }));
  const bookByMonth = monthRows.map((r) => ({ month: r.month, fyEnd: n(r.fyEnd), total: n(r.bookings) }));

  // "All years" roll-up. Deals partition by their creation FY, so summing the
  // per-FY (already deal-distinct) totals is the all-years distinct count.
  const sum = (arr) => arr.reduce(
    (a, r) => ({ ads: a.ads + r.ads, indirect: a.indirect + r.indirect, total: a.total + r.total }),
    { ads: 0, indirect: 0, total: 0 },
  );

  return {
    enquiries: { byFy: enqByFy, byMonth: enqByMonth, total: sum(enqByFy), meta: { status: 'live', source: SRC_ENQ, note: null } },
    bookings: { byFy: bookByFy, byMonth: bookByMonth, total: sum(bookByFy), meta: { status: 'live', source: SRC_BOOK, note: null } },
  };
}
