// Marketing ROI — whole-business revenue vs TOTAL SPEND, by AUSTRALIAN FINANCIAL YEAR
// (Jul–Jun, END-year convention: FY27 = Jul 2026–Jun 2027), the same FY framing the
// ROAS tab uses. LIVE, computed at request time from Supabase.
//
// WHOLE-BUSINESS (not ad-attributed like ROAS):
//   • Revenue    → ALL Xero sales invoices, public.invoice_tracking, bucketed by invoice_date
//                  (sum of amount_total, incl GST). invoice_tracking is scoped 2026 ONWARDS, so
//                  revenue only exists for FY26 (partial, Jan–Jun 2026) and FY27 (Jul 2026+);
//                  earlier FYs read null revenue (a blank, not a $0). The page flags this.
//   • Total spend → ALL Xero expenses across every dept = operating_expenses + cost_of_sales,
//                  public.xero_expenses_monthly (seeded from the Xero P&L; see that table's
//                  comment). This REPLACED the old ad-only spend (google/bing/simple_digital).
//   • Deals      → ALL ActiveCampaign deals, public.activecampaign_deals, bucketed by cdate.
//                  status 1=won, 2=lost, 0=open. Won value via public.ac_value_aud (cents→AUD).
//                  Also broken down PER PIPELINE (activecampaign_deals."group") for the pipeline
//                  chart — group→name map below (from AC dealGroups).
//
// FY axis = FYs that have Xero expenses OR Xero revenue (≈ FY25–FY27). The frontend filters the
// returned per-FY rows + monthly series client-side via an FY bar (default = current FY).

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC =
  'Live (Supabase): revenue from invoice_tracking (Xero, 2026+); total spend from ' +
  'xero_expenses_monthly (Xero P&L: operating expenses + cost of sales); deals from activecampaign_deals';

// AU financial-year END year from a date column: calendar year + 1 if month >= July.
const FY = (col) =>
  `extract(year FROM ${col})::int + CASE WHEN extract(month FROM ${col}) >= 7 THEN 1 ELSE 0 END`;

// Only months from FY25 start onward feed the monthly chart.
const MONTH_FLOOR = '2024-07-01';

// AC deal pipeline (dealGroups) id → display name. Static (from list_deal_pipelines);
// activecampaign_deals."group" holds the id. Unknown ids fall back to "Pipeline <id>".
const PIPELINES = {
  '3': 'Keynotes/Workshops/Immersive (LIV)',
  '5': 'MAG Team Offsite',
  '7': 'The Tailor',
  '9': 'Executive X (2024)',
  '14': 'Executive X Master',
  '17': 'Trojan Horse: Post-Conf',
  '18': 'Leader X',
  '19': 'NRL Pre-Season 2027',
  '20': 'Trojan Horse: Post-Exec X',
};
const pipelineName = (g) => PIPELINES[String(g)] || `Pipeline ${g}`;

const BY_FY = `
  WITH rev AS (
    SELECT ${FY('invoice_date')} AS fy_end, sum(amount_total) AS revenue
    FROM public.invoice_tracking WHERE invoice_date IS NOT NULL GROUP BY 1
  ),
  spend AS (
    SELECT ${FY('month')} AS fy_end,
      sum(operating_expenses) AS op_ex, sum(cost_of_sales) AS cos, sum(total_spend) AS total
    FROM public.xero_expenses_monthly GROUP BY 1
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
    SELECT fy_end FROM spend
    UNION
    SELECT fy_end FROM rev WHERE revenue IS NOT NULL
  )
  SELECT
    a.fy_end                              AS "fyEnd",
    'FY' || right(a.fy_end::text, 2)      AS "fy",
    round(rev.revenue)::numeric           AS "revenue",      -- null for pre-2026 FYs
    round(coalesce(s.op_ex, 0))::numeric  AS "opEx",
    round(coalesce(s.cos, 0))::numeric    AS "cos",
    round(coalesce(s.total, 0))::numeric  AS "totalSpend",
    coalesce(d.won, 0)                    AS "dealsWon",
    coalesce(d.open, 0)                   AS "dealsOpen",
    coalesce(d.lost, 0)                   AS "dealsLost",
    coalesce(d.won_value, 0)::numeric     AS "wonValue"
  FROM axis a
  LEFT JOIN rev   ON rev.fy_end = a.fy_end
  LEFT JOIN spend s ON s.fy_end = a.fy_end
  LEFT JOIN d     ON d.fy_end = a.fy_end
  ORDER BY a.fy_end`;

const BY_MONTH = `
  WITH rev AS (
    SELECT to_char(date_trunc('month', invoice_date), 'YYYY-MM') AS month, sum(amount_total) AS revenue
    FROM public.invoice_tracking WHERE invoice_date >= '${MONTH_FLOOR}' GROUP BY 1
  ),
  spend AS (
    SELECT to_char(date_trunc('month', month), 'YYYY-MM') AS month, sum(total_spend) AS spend
    FROM public.xero_expenses_monthly WHERE month >= '${MONTH_FLOOR}' GROUP BY 1
  )
  SELECT coalesce(rev.month, spend.month)   AS "month",
         round(coalesce(rev.revenue, 0))::numeric AS "revenue",
         round(coalesce(spend.spend, 0))::numeric AS "spend"
  FROM rev FULL OUTER JOIN spend ON rev.month = spend.month
  ORDER BY 1`;

// Per-pipeline deal counts by FY (for the "AC pipeline" chart, one bar per pipeline).
const PIPELINE_SQL = `
  SELECT ${FY('cdate')} AS "fyEnd", "group" AS "group",
    count(*) FILTER (WHERE status = 1) AS "won",
    count(*) FILTER (WHERE status = 0) AS "open",
    count(*) FILTER (WHERE status = 2) AS "lost"
  FROM public.activecampaign_deals
  WHERE cdate IS NOT NULL AND "group" IS NOT NULL
  GROUP BY 1, 2`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

// FY END year a 'YYYY-MM' month belongs to.
function fyEndOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y + (m >= 7 ? 1 : 0);
}

function shape(r) {
  const revenue = num(r.revenue); // null = no Xero invoice history for this FY (pre-2026)
  const totalSpend = num(r.totalSpend) || 0;
  return {
    fy: r.fy,
    fyEnd: num(r.fyEnd),
    revenue,
    hasRevenue: revenue !== null,
    opEx: num(r.opEx) || 0,
    cos: num(r.cos) || 0,
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
    opEx: sum('opEx'),
    cos: sum('cos'),
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
    const pend = { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' };
    return {
      asOf: new Date().toISOString(),
      defaultFy: null,
      total: null,
      rows: section([], pend),
      byMonth: section([], pend),
      pipelines: section([], pend),
    };
  }

  const [fyRows, monthRows, pipeRows] = await Promise.all([q(BY_FY), q(BY_MONTH), q(PIPELINE_SQL)]);
  const rows = fyRows.map(shape);

  if (!rows.length) {
    const note = 'No Xero expenses or revenue found — seed xero_expenses_monthly / invoice_tracking.';
    const pend = { source: SRC, status: 'pending', note };
    return {
      asOf: new Date().toISOString(),
      defaultFy: null,
      total: null,
      rows: section([], pend),
      byMonth: section([], pend),
      pipelines: section([], pend),
    };
  }

  const fyEnds = rows.map((r) => r.fyEnd);

  const months = monthRows.map((m) => ({
    month: m.month,
    fyEnd: fyEndOfMonth(m.month),
    revenue: num(m.revenue) || 0,
    spend: num(m.spend) || 0,
  }));

  // Per-pipeline counts, scoped to the FY axis (so the chart matches the shown FYs).
  const pipelines = pipeRows
    .filter((p) => fyEnds.includes(num(p.fyEnd)))
    .map((p) => ({
      fyEnd: num(p.fyEnd),
      group: String(p.group),
      pipeline: pipelineName(p.group),
      won: num(p.won) || 0,
      open: num(p.open) || 0,
      lost: num(p.lost) || 0,
    }));

  const total = totalRow(rows);

  // Default the page to the current FY if it's in the axis, else the latest FY present.
  const now = new Date();
  const curFy = now.getUTCFullYear() + (now.getUTCMonth() + 1 >= 7 ? 1 : 0);
  const defaultFy = fyEnds.includes(curFy) ? curFy : fyEnds[fyEnds.length - 1];

  const firstRev = rows.find((r) => r.hasRevenue);
  const note =
    `${rows.length} FY(s) (${rows[0].fy}–${rows[rows.length - 1].fy}). ` +
    `Revenue = all Xero invoices (incl GST); total spend = all Xero expenses (operating + cost of ` +
    `sales) across every dept; deals = all ActiveCampaign deals by created date. ` +
    `Xero invoice history starts Jan 2026, so revenue exists only from ${firstRev ? firstRev.fy : 'FY26'} onward ` +
    `(earlier FYs show spend/deals but no revenue, and FY26 revenue is partial — Jan–Jun 2026 only — so its ` +
    `ROI is understated against a full year of spend). Expenses are a static Xero P&L load (refresh pending).`;

  return {
    asOf: new Date().toISOString(),
    defaultFy,
    total,
    rows: section(rows, { source: SRC, status: 'live', note }),
    byMonth: section(months, { source: SRC, status: 'live', note: null }),
    pipelines: section(pipelines, { source: SRC, status: 'live', note: null }),
  };
}
