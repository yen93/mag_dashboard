// Marketing ROI — whole-business revenue vs TOTAL SPEND, by AUSTRALIAN FINANCIAL YEAR
// (Jul–Jun, END-year convention: FY27 = Jul 2026–Jun 2027), the same FY framing the
// ROAS tab uses. LIVE, computed at request time from Supabase.
//
// WHOLE-BUSINESS (not ad-attributed like ROAS):
//   • Revenue    → Xero P&L "Total Income" per month, public.xero_expenses_monthly.total_income
//                  (ex-GST, accrual). Sourced from the same monthly P&L as spend, so revenue and
//                  spend are apples-to-apples. (This REPLACED the old invoice_tracking source,
//                  which was 2026+ only and incl-GST — see git history / CLAUDE.md.)
//   • Total spend → ALL Xero expenses across every dept = operating_expenses + cost_of_sales,
//                  public.xero_expenses_monthly (seeded from the Xero P&L; see that table's
//                  comment). This REPLACED the old ad-only spend (google/bing/simple_digital).
//   • Deals      → ALL ActiveCampaign deals, public.activecampaign_deals, bucketed by cdate.
//                  status 1=won, 2=lost, 0=open. Won value via public.ac_value_aud (cents→AUD).
//                  Also broken down PER PIPELINE (activecampaign_deals."group") for the pipeline
//                  chart — group→name map below (from AC dealGroups).
//
// FY axis = FYs that have Xero P&L (revenue/spend) OR ActiveCampaign deals. Xero's API only
// exposes the current + 3 prior financial years, so P&L reaches back to FY24 only; deals reach
// FY22. So FY22/FY23 appear with deal counts but BLANK revenue/spend/ROI (null, not $0) — the
// page flags this. The frontend filters the returned per-FY rows + monthly series client-side
// via an FY bar (default = current FY).

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC =
  'Live (Supabase): revenue + total spend from xero_expenses_monthly (Xero P&L: total income, ' +
  'operating expenses, cost of sales); deals from activecampaign_deals';

// AU financial-year END year from a date column: calendar year + 1 if month >= July.
const FY = (col) =>
  `extract(year FROM ${col})::int + CASE WHEN extract(month FROM ${col}) >= 7 THEN 1 ELSE 0 END`;

// Earliest month fed to the monthly chart = FY24 start (the oldest Xero P&L we can pull).
const MONTH_FLOOR = '2023-07-01';

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
  WITH pnl AS (
    SELECT ${FY('month')} AS fy_end,
      sum(total_income)      AS revenue,
      sum(operating_expenses) AS op_ex,
      sum(cost_of_sales)      AS cos,
      sum(total_spend)        AS total,
      sum(coalesce(owner_wages, 0)) AS owner_wages
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
    SELECT fy_end FROM pnl
    UNION
    SELECT fy_end FROM d
  )
  SELECT
    a.fy_end                              AS "fyEnd",
    'FY' || right(a.fy_end::text, 2)      AS "fy",
    round(p.revenue)::numeric             AS "revenue",     -- null for FYs with no Xero P&L (FY22/FY23)
    round(p.op_ex)::numeric               AS "opEx",
    round(p.cos)::numeric                 AS "cos",
    round(p.total)::numeric               AS "totalSpend",  -- null for FYs with no Xero P&L
    round(p.owner_wages)::numeric         AS "ownerWages",  -- owner/director wages+super (subset of opEx)
    coalesce(d.won, 0)                    AS "dealsWon",
    coalesce(d.open, 0)                   AS "dealsOpen",
    coalesce(d.lost, 0)                   AS "dealsLost",
    coalesce(d.won_value, 0)::numeric     AS "wonValue"
  FROM axis a
  LEFT JOIN pnl p ON p.fy_end = a.fy_end
  LEFT JOIN d     ON d.fy_end = a.fy_end
  ORDER BY a.fy_end`;

const BY_MONTH = `
  SELECT to_char(date_trunc('month', month), 'YYYY-MM') AS "month",
         round(coalesce(total_income, 0))::numeric AS "revenue",
         round(coalesce(total_spend, 0))::numeric  AS "spend",
         round(coalesce(owner_wages, 0))::numeric  AS "ownerWages"
  FROM public.xero_expenses_monthly
  WHERE month >= '${MONTH_FLOOR}'
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
  const revenue = num(r.revenue);       // null = no Xero P&L for this FY (FY22/FY23)
  const totalSpend = num(r.totalSpend); // null = no Xero P&L for this FY (FY22/FY23)
  return {
    fy: r.fy,
    fyEnd: num(r.fyEnd),
    revenue,
    hasRevenue: revenue !== null,
    opEx: num(r.opEx),
    cos: num(r.cos),
    totalSpend,
    hasSpend: totalSpend !== null,
    ownerWages: num(r.ownerWages) || 0, // owner/director wages+super (subset of totalSpend)
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
  const anySpend = rows.some((r) => r.hasSpend);
  const revenue = anyRevenue ? sum('revenue') : null;
  const totalSpend = anySpend ? sum('totalSpend') : null;
  return {
    fy: 'All',
    fyEnd: null,
    revenue,
    hasRevenue: anyRevenue,
    opEx: sum('opEx'),
    cos: sum('cos'),
    totalSpend,
    hasSpend: anySpend,
    ownerWages: sum('ownerWages'),
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
    const note = 'No Xero P&L found — seed xero_expenses_monthly (total_income/expenses/cost_of_sales).';
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
    ownerWages: num(m.ownerWages) || 0,
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
    `Revenue = Xero P&L total income (ex-GST); total spend = all Xero expenses (operating + cost of ` +
    `sales) across every dept; deals = all ActiveCampaign deals by created date. ` +
    `Xero only exposes the last 4 financial years, so revenue/spend reach back to ${firstRev ? firstRev.fy : 'FY24'} ` +
    `only — earlier FYs (${rows[0].fy}+) show deal counts but blank revenue/spend/ROI. The current FY is ` +
    `partial (year-to-date), so its spend is below a full year. The "excl. owner wages" toggle removes ` +
    `director wages+super (Wages/Super – James & Mia) from spend/ROI — the business runs near-breakeven ` +
    `with them in. Expenses/revenue are a static Xero P&L load (refresh pending).`;

  return {
    asOf: new Date().toISOString(),
    defaultFy,
    total,
    rows: section(rows, { source: SRC, status: 'live', note }),
    byMonth: section(months, { source: SRC, status: 'live', note: null }),
    pipelines: section(pipelines, { source: SRC, status: 'live', note: null }),
  };
}
