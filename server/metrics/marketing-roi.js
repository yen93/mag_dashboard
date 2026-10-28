// Marketing ROI — whole-business revenue vs ad spend, by AUSTRALIAN FINANCIAL YEAR
// (Jul–Jun, END-year convention: FY27 = Jul 2026–Jun 2027), the same FY framing the
// ROAS tab uses. LIVE, computed at request time from Supabase.
//
// Unlike the ROAS tab (which is ad-ATTRIBUTED), this is WHOLE-BUSINESS:
//   • Revenue   → ALL Xero sales invoices, public.invoice_tracking, bucketed by invoice_date
//                 (sum of amount_total, the invoice total incl GST). NB: invoice_tracking is
//                 scoped 2026 ONWARDS, so revenue only exists for FY26 (partial, Jan–Jun 2026)
//                 and FY27 (Jul 2026+). Earlier FYs read null revenue (a blank, not a $0) —
//                 the page flags this. Nothing to do here but surface it.
//   • Ad spend  → all-in paid search = Google (google_ads_campaign_monthly.cost) + Bing
//                 (bing_ads_campaign_monthly.cost) + Simple Digital
//                 (simple_digital_fees_monthly.paid_search_fee), bucketed by each table's
//                 `month`. Same three tables the ROAS All-in basis sums.
//   • Deals     → ALL ActiveCampaign deals, public.activecampaign_deals, bucketed by cdate.
//                 status 1=won, 2=lost, 0=open. Won value via public.ac_value_aud (cents→AUD,
//                 USD converted) — the shared rate source, so it reconciles with ROAS/Sales.
//
// FY axis = FYs that have Google ad spend OR Xero revenue (the paid-search / Xero era ≈
// FY25–FY27). Earlier SD-only or deal-only years are not shown. The frontend filters the
// returned per-FY rows + monthly series client-side via an FY bar (default = current FY).

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC =
  'Live (Supabase): revenue from invoice_tracking (Xero, 2026+); ad spend from ' +
  'google/bing/simple_digital monthly tables; deals from activecampaign_deals';

// AU financial-year END year from a date column: calendar year + 1 if month >= July.
const FY = (col) =>
  `extract(year FROM ${col})::int + CASE WHEN extract(month FROM ${col}) >= 7 THEN 1 ELSE 0 END`;

// Only months from FY25 start onward feed the monthly chart (keeps the "All" view tidy —
// Simple Digital has history back to FY22 but there's no revenue to compare it against).
const MONTH_FLOOR = '2024-07-01';

const BY_FY = `
  WITH rev AS (
    SELECT ${FY('invoice_date')} AS fy_end, sum(amount_total) AS revenue
    FROM public.invoice_tracking WHERE invoice_date IS NOT NULL GROUP BY 1
  ),
  g AS (
    SELECT ${FY('month')} AS fy_end, sum(cost) AS google
    FROM public.google_ads_campaign_monthly GROUP BY 1
  ),
  b AS (
    SELECT ${FY('month')} AS fy_end, sum(cost) AS bing
    FROM public.bing_ads_campaign_monthly GROUP BY 1
  ),
  sd AS (
    SELECT ${FY('month')} AS fy_end, sum(paid_search_fee) AS sd
    FROM public.simple_digital_fees_monthly GROUP BY 1
  ),
  d AS (
    SELECT ${FY('cdate')} AS fy_end,
      count(*) FILTER (WHERE status = 1) AS won,
      count(*) FILTER (WHERE status = 0) AS open,
      count(*) FILTER (WHERE status = 2) AS lost,
      round(coalesce(sum(public.ac_value_aud(value, currency)) FILTER (WHERE status = 1), 0))::numeric AS won_value
    FROM public.activecampaign_deals WHERE cdate IS NOT NULL GROUP BY 1
  ),
  axis AS (
    SELECT fy_end FROM g WHERE google > 0
    UNION
    SELECT fy_end FROM rev WHERE revenue IS NOT NULL
  )
  SELECT
    a.fy_end                              AS "fyEnd",
    'FY' || right(a.fy_end::text, 2)      AS "fy",
    round(rev.revenue)::numeric           AS "revenue",      -- null for pre-2026 FYs
    round(coalesce(g.google, 0))::numeric AS "googleSpend",
    round(coalesce(b.bing, 0))::numeric   AS "bingSpend",
    round(coalesce(sd.sd, 0))::numeric    AS "sdFee",
    coalesce(d.won, 0)                    AS "dealsWon",
    coalesce(d.open, 0)                   AS "dealsOpen",
    coalesce(d.lost, 0)                   AS "dealsLost",
    coalesce(d.won_value, 0)::numeric     AS "wonValue"
  FROM axis a
  LEFT JOIN rev ON rev.fy_end = a.fy_end
  LEFT JOIN g   ON g.fy_end   = a.fy_end
  LEFT JOIN b   ON b.fy_end   = a.fy_end
  LEFT JOIN sd  ON sd.fy_end  = a.fy_end
  LEFT JOIN d   ON d.fy_end   = a.fy_end
  ORDER BY a.fy_end`;

const BY_MONTH = `
  WITH rev AS (
    SELECT to_char(date_trunc('month', invoice_date), 'YYYY-MM') AS month, sum(amount_total) AS revenue
    FROM public.invoice_tracking WHERE invoice_date >= '${MONTH_FLOOR}' GROUP BY 1
  ),
  spend AS (
    SELECT month, sum(c) AS spend FROM (
      SELECT to_char(date_trunc('month', month), 'YYYY-MM') AS month, sum(cost) AS c
        FROM public.google_ads_campaign_monthly WHERE month >= '${MONTH_FLOOR}' GROUP BY 1
      UNION ALL
      SELECT to_char(date_trunc('month', month), 'YYYY-MM'), sum(cost)
        FROM public.bing_ads_campaign_monthly WHERE month >= '${MONTH_FLOOR}' GROUP BY 1
      UNION ALL
      SELECT to_char(date_trunc('month', month), 'YYYY-MM'), sum(paid_search_fee)
        FROM public.simple_digital_fees_monthly WHERE month >= '${MONTH_FLOOR}' GROUP BY 1
    ) u GROUP BY month
  )
  SELECT coalesce(rev.month, spend.month)   AS "month",
         round(coalesce(rev.revenue, 0))::numeric AS "revenue",
         round(coalesce(spend.spend, 0))::numeric AS "spend"
  FROM rev FULL OUTER JOIN spend ON rev.month = spend.month
  ORDER BY 1`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

// FY END year a 'YYYY-MM' month belongs to.
function fyEndOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y + (m >= 7 ? 1 : 0);
}

function shape(r) {
  const revenue = num(r.revenue); // null = no Xero invoice history for this FY (pre-2026)
  const googleSpend = num(r.googleSpend) || 0;
  const bingSpend = num(r.bingSpend) || 0;
  const sdFee = num(r.sdFee) || 0;
  const totalSpend = googleSpend + bingSpend + sdFee;
  return {
    fy: r.fy,
    fyEnd: num(r.fyEnd),
    revenue,
    hasRevenue: revenue !== null,
    googleSpend,
    bingSpend,
    sdFee,
    totalSpend,
    dealsWon: num(r.dealsWon) || 0,
    dealsOpen: num(r.dealsOpen) || 0,
    dealsLost: num(r.dealsLost) || 0,
    wonValue: num(r.wonValue) || 0,
    roi: revenue !== null && totalSpend ? revenue / totalSpend : null,
  };
}

// "All years" total — summed; the ROI ratio is recomputed from the sums, not averaged.
function totalRow(rows) {
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const anyRevenue = rows.some((r) => r.hasRevenue);
  const revenue = anyRevenue ? sum('revenue') : null;
  const totalSpend = sum('totalSpend');
  return {
    fy: 'All',
    fyEnd: null,
    revenue,
    hasRevenue: anyRevenue,
    googleSpend: sum('googleSpend'),
    bingSpend: sum('bingSpend'),
    sdFee: sum('sdFee'),
    totalSpend,
    dealsWon: sum('dealsWon'),
    dealsOpen: sum('dealsOpen'),
    dealsLost: sum('dealsLost'),
    wonValue: sum('wonValue'),
    roi: revenue !== null && totalSpend ? revenue / totalSpend : null,
  };
}

export async function getMarketingRoi() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      defaultFy: null,
      total: null,
      rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
      byMonth: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
    };
  }

  const [fyRows, monthRows] = await Promise.all([q(BY_FY), q(BY_MONTH)]);
  const rows = fyRows.map(shape);

  if (!rows.length) {
    const note = 'No ad spend or Xero revenue found — populate invoice_tracking / the ad-spend monthly tables.';
    return {
      asOf: new Date().toISOString(),
      defaultFy: null,
      total: null,
      rows: section([], { source: SRC, status: 'pending', note }),
      byMonth: section([], { source: SRC, status: 'pending', note }),
    };
  }

  const months = monthRows.map((m) => ({
    month: m.month,
    fyEnd: fyEndOfMonth(m.month),
    revenue: num(m.revenue) || 0,
    spend: num(m.spend) || 0,
  }));

  const total = totalRow(rows);

  // Default the page to the current FY if it's in the axis, else the latest FY present.
  const now = new Date();
  const curFy = now.getUTCFullYear() + (now.getUTCMonth() + 1 >= 7 ? 1 : 0);
  const fyEnds = rows.map((r) => r.fyEnd);
  const defaultFy = fyEnds.includes(curFy) ? curFy : fyEnds[fyEnds.length - 1];

  const firstRev = rows.find((r) => r.hasRevenue);
  const note =
    `${rows.length} FY(s) (${rows[0].fy}–${rows[rows.length - 1].fy}). ` +
    `Revenue = all Xero invoices (incl GST); ad spend = Google + Bing + Simple Digital; ` +
    `deals = all ActiveCampaign deals by created date. ` +
    `Xero invoice history starts 2026, so revenue is available from ${firstRev ? firstRev.fy : 'FY26'} onward ` +
    `(earlier FYs show spend/deals but no revenue).`;

  return {
    asOf: new Date().toISOString(),
    defaultFy,
    total,
    rows: section(rows, { source: SRC, status: 'live', note }),
    byMonth: section(months, { source: SRC, status: 'live', note: null }),
  };
}
