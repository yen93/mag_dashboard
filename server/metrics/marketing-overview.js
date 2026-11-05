// Marketing Overview — live KPI(s) for the Marketing Overview page.
//
// Currently the "Keynote enquiries" headline: the total number of ActiveCampaign
// deals CREATED in a financial year across the four "deal groups" the business
// tracks (deduped by deal, so a deal in more than one group counts once):
//   • ads     → paid-search-counted deals, public.roas_counted_deals (the same
//               canonical view the ROAS tab counts). FY from the deal cdate.
//   • organic → organic-search-sourced deals on public.ga4_ac_contact_source
//               (channel ~* 'organic'). FY from cdate. NB ga4_ac_contact_source
//               keeps a rolling ~60-day window, so older organic deals age out
//               and read low for past FYs.
//   • bureau  → public.ac_deals_ytd.is_bureau. FY from deal_created_at.
//   • tailor  → public.ac_deals_ytd.is_tailor. FY from deal_created_at.
//               (ac_deals_ytd only covers Jul-2024+, so bureau/tailor read 0
//               before FY25.)
// "Created in FY" = the deal's creation date, Australian FY (Jul–Jun, END-year:
// FY27 = Jul 2026 – Jun 2027) — the same FY framing the ROAS and ROI tabs use.
// Status-agnostic (all deals, not only won). LIVE, computed at request time.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC =
  'Live (Supabase): count of deals created per FY across the four deal groups — ads ' +
  '(roas_counted_deals) + organic search (ga4_ac_contact_source, channel~organic) + bureau + ' +
  'tailor (ac_deals_ytd) — deduped by deal.';

// AU financial-year END year from a date column: calendar year + 1 if month >= July.
const FY = (col) =>
  `extract(year FROM ${col})::int + CASE WHEN extract(month FROM ${col}) >= 7 THEN 1 ELSE 0 END`;

const ENQUIRIES_SQL = `
  WITH ads AS (
    SELECT DISTINCT deal_id::text AS deal_id, ${FY('cdate')} AS fy_end, 'ads' AS grp
    FROM public.roas_counted_deals WHERE cdate IS NOT NULL AND deal_id IS NOT NULL
  ),
  organic AS (
    SELECT DISTINCT deal_id::text AS deal_id, ${FY('cdate')} AS fy_end, 'organic' AS grp
    FROM public.ga4_ac_contact_source
    WHERE channel ~* 'organic' AND deal_id IS NOT NULL AND cdate IS NOT NULL
  ),
  bureau AS (
    SELECT DISTINCT ac_deal_id::text AS deal_id, ${FY('deal_created_at')} AS fy_end, 'bureau' AS grp
    FROM public.ac_deals_ytd WHERE is_bureau AND ac_deal_id IS NOT NULL AND deal_created_at IS NOT NULL
  ),
  tailor AS (
    SELECT DISTINCT ac_deal_id::text AS deal_id, ${FY('deal_created_at')} AS fy_end, 'tailor' AS grp
    FROM public.ac_deals_ytd WHERE is_tailor AND ac_deal_id IS NOT NULL AND deal_created_at IS NOT NULL
  ),
  u AS (
    SELECT * FROM ads UNION ALL SELECT * FROM organic
    UNION ALL SELECT * FROM bureau UNION ALL SELECT * FROM tailor
  )
  SELECT fy_end AS "fyEnd",
    count(*) FILTER (WHERE grp = 'ads')     AS ads,
    count(*) FILTER (WHERE grp = 'organic') AS organic,
    count(*) FILTER (WHERE grp = 'bureau')  AS bureau,
    count(*) FILTER (WHERE grp = 'tailor')  AS tailor,
    count(DISTINCT deal_id)                 AS total
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
    organic: n(r.organic),
    bureau: n(r.bureau),
    tailor: n(r.tailor),
    total: n(r.total),
  }));
  // "All years" roll-up. Deals partition by their creation FY, so summing the
  // per-FY (already deal-distinct) totals is the all-years distinct count.
  const total = byFy.reduce(
    (a, r) => ({
      ads: a.ads + r.ads, organic: a.organic + r.organic,
      bureau: a.bureau + r.bureau, tailor: a.tailor + r.tailor, total: a.total + r.total,
    }),
    { ads: 0, organic: 0, bureau: 0, tailor: 0, total: 0 },
  );

  return { enquiries: { byFy, total, meta: { status: 'live', source: SRC, note: null } } };
}
