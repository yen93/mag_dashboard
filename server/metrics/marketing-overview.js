// Marketing Overview — live KPI(s) for the Marketing Overview page.
//
// Currently the "Keynote enquiries" headline: the total number of ActiveCampaign
// deals CREATED in a financial year across the two sources the business counts
// as enquiries (deduped by deal, so a deal in both sources counts once):
//   • ads      → paid-search-counted deals, public.roas_counted_deals (the same
//                canonical view the ROAS tab counts). FY from the deal cdate.
//   • indirect → indirect / bureau deals, public.ac_indirect_deals (every AC deal
//                whose "Deal Source?" = Indirect, 2021→present). FY from cdate.
// "Created in FY" = the deal's creation date, Australian FY (Jul–Jun, END-year:
// FY27 = Jul 2026 – Jun 2027) — the same FY framing the ROAS and ROI tabs use.
// Status-agnostic (all deals, not only won). LIVE, computed at request time.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC =
  'Live (Supabase): count of deals created per FY across two sources — ads ' +
  '(roas_counted_deals) + indirect/bureau (ac_indirect_deals) — deduped by deal.';

// AU financial-year END year from a date column: calendar year + 1 if month >= July.
const FY = (col) =>
  `extract(year FROM ${col})::int + CASE WHEN extract(month FROM ${col}) >= 7 THEN 1 ELSE 0 END`;

const ENQUIRIES_SQL = `
  WITH ads AS (
    SELECT DISTINCT deal_id::text AS deal_id, ${FY('cdate')} AS fy_end, 'ads' AS grp
    FROM public.roas_counted_deals WHERE cdate IS NOT NULL AND deal_id IS NOT NULL
  ),
  indirect AS (
    SELECT DISTINCT deal_id::text AS deal_id, ${FY('cdate')} AS fy_end, 'indirect' AS grp
    FROM public.ac_indirect_deals WHERE cdate IS NOT NULL AND deal_id IS NOT NULL
  ),
  u AS (
    SELECT * FROM ads UNION ALL SELECT * FROM indirect
  )
  SELECT fy_end AS "fyEnd",
    count(*) FILTER (WHERE grp = 'ads')      AS ads,
    count(*) FILTER (WHERE grp = 'indirect') AS indirect,
    count(DISTINCT deal_id)                  AS total
  FROM u
  GROUP BY fy_end
  ORDER BY fy_end`;

export async function getMarketingOverview() {
  if (!supabaseConfigured()) {
    return {
      enquiries: {
        byFy: [], total: null,
        meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' },
      },
    };
  }

  const n = (v) => Number(v) || 0;
  const rows = await q(ENQUIRIES_SQL);
  const byFy = rows.map((r) => ({
    fyEnd: n(r.fyEnd),
    fy: 'FY' + String(r.fyEnd).slice(-2),
    ads: n(r.ads),
    indirect: n(r.indirect),
    total: n(r.total),
  }));
  // "All years" roll-up. Deals partition by their creation FY, so summing the
  // per-FY (already deal-distinct) totals is the all-years distinct count.
  const total = byFy.reduce(
    (a, r) => ({
      ads: a.ads + r.ads, indirect: a.indirect + r.indirect, total: a.total + r.total,
    }),
    { ads: 0, indirect: 0, total: 0 },
  );

  return { enquiries: { byFy, total, meta: { status: 'live', source: SRC, note: null } } };
}
