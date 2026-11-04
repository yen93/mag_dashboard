// Marketing ROI — whole-business revenue vs MARKETING SPEND, by AUSTRALIAN FINANCIAL YEAR
// (Jul–Jun, END-year convention: FY27 = Jul 2026–Jun 2027), the same FY framing the
// ROAS tab uses. LIVE, computed at request time from Supabase.
//
// Revenue is WHOLE-BUSINESS; spend is MARKETING-ONLY (return on marketing investment):
//   • Revenue      → Xero P&L "Total Income" per month, public.xero_expenses_monthly.total_income
//                    (ex-GST, accrual).
//   • Marketing spend → public.marketing_channel_monthly (the SAME live-from-Xero marketing
//                    pipeline that backs the Channel Summary chart), summed by month/FY. This is
//                    EXACTLY the "Marketing Expenses - Xero Account - Description.md" scope: Xero
//                    accounts 302 Advertising (ALL vendors) + 475 Website / 332 Software /
//                    411 Printing / 377 WrkPod-Staff (listed vendors only, via
//                    marketing_channel_vendor_map). ex-GST. (REPLACED the old whole-business
//                    spend = operating_expenses + cost_of_sales on 2026-11-02 — so owner/director
//                    wages no longer figure here at all.)
//   • Deals        → ALL ActiveCampaign deals, public.activecampaign_deals, bucketed by cdate.
//                    status 1=won, 2=lost, 0=open. Won value via public.ac_value_aud (cents→AUD).
//                    Also broken down PER PIPELINE (activecampaign_deals."group") for the pipeline
//                    chart — group→name map below (from AC dealGroups).
//
// FY axis = FYs that have Xero P&L (revenue) OR marketing spend OR ActiveCampaign deals. The
// marketing-spend pipeline and the revenue P&L both reach back to FY22 (FY22 is partial — Xero
// bank-txn history begins ~early 2022). The frontend filters the returned per-FY rows + monthly
// series client-side via an FY bar (default = current FY).

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC =
  'Live (Supabase): revenue from xero_expenses_monthly (Xero P&L total income); marketing spend ' +
  'from marketing_channel_monthly (Xero marketing accounts 302/475/332/411/377); deals from ' +
  'activecampaign_deals';

// Source string for the "Marketing revenue" card (marketing-attributed won revenue).
const SRC_MR =
  'Live (Supabase): won revenue from paid-ad deals (roas_counted_deals) + organic-search deals ' +
  '(ga4_ac_contact_source) + bureau/tailor deals (ac_deals_ytd) + Executive X (exec_x_revenue, ' +
  'from the Exec X ROI sheet). Deduped by deal_id; won deals only.';

// AU financial-year END year from a date column: calendar year + 1 if month >= July.
const FY = (col) =>
  `extract(year FROM ${col})::int + CASE WHEN extract(month FROM ${col}) >= 7 THEN 1 ELSE 0 END`;

// Earliest month fed to the monthly chart = FY22 start.
const MONTH_FLOOR = '2021-07-01';

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

// Xero marketing account code → display name (the five accounts the marketing-spend pipeline
// covers; see marketing_channel_monthly / the xero-channel-summary-sync edge function).
const ACCOUNT_NAMES = {
  '302': 'Advertising and marketing',
  '475': 'Website Expenses',
  '332': 'Software subscriptions',
  '411': 'Printing, stationery & postage',
  '377': 'WrkPod Staff',
};
const accountName = (code) => ACCOUNT_NAMES[String(code)] || `Account ${code}`;

const BY_FY = `
  WITH pnl AS (
    SELECT ${FY('month')} AS fy_end, sum(total_income) AS revenue
    FROM public.xero_expenses_monthly GROUP BY 1
  ),
  mkt AS (
    SELECT ${FY('month')} AS fy_end, sum(amount) AS spend
    FROM public.marketing_channel_monthly GROUP BY 1
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
    UNION SELECT fy_end FROM mkt
    UNION SELECT fy_end FROM d
  )
  SELECT
    a.fy_end                              AS "fyEnd",
    'FY' || right(a.fy_end::text, 2)      AS "fy",
    round(p.revenue)::numeric             AS "revenue",     -- null for FYs with no Xero P&L
    round(mk.spend)::numeric              AS "totalSpend",  -- marketing spend; null for FYs with none
    coalesce(d.won, 0)                    AS "dealsWon",
    coalesce(d.open, 0)                   AS "dealsOpen",
    coalesce(d.lost, 0)                   AS "dealsLost",
    coalesce(d.won_value, 0)::numeric     AS "wonValue"
  FROM axis a
  LEFT JOIN pnl p  ON p.fy_end = a.fy_end
  LEFT JOIN mkt mk ON mk.fy_end = a.fy_end
  LEFT JOIN d      ON d.fy_end  = a.fy_end
  ORDER BY a.fy_end`;

// Revenue (whole-business P&L) vs marketing spend, per month, over the union of months either
// source has. Months missing from one side read 0 there.
const BY_MONTH = `
  WITH rev AS (
    SELECT date_trunc('month', month)::date AS m, sum(total_income) AS revenue
    FROM public.xero_expenses_monthly WHERE month >= '${MONTH_FLOOR}' GROUP BY 1
  ),
  sp AS (
    SELECT date_trunc('month', month)::date AS m, sum(amount) AS spend
    FROM public.marketing_channel_monthly WHERE month >= '${MONTH_FLOOR}' GROUP BY 1
  ),
  months AS (SELECT m FROM rev UNION SELECT m FROM sp)
  SELECT to_char(mo.m, 'YYYY-MM')              AS "month",
         round(coalesce(rev.revenue, 0))::numeric AS "revenue",
         round(coalesce(sp.spend, 0))::numeric    AS "spend"
  FROM months mo
  LEFT JOIN rev ON rev.m = mo.m
  LEFT JOIN sp  ON sp.m  = mo.m
  ORDER BY 1`;

// Per-pipeline deal counts by FY (kept for the ROI assistant snapshot).
const PIPELINE_SQL = `
  SELECT ${FY('cdate')} AS "fyEnd", "group" AS "group",
    count(*) FILTER (WHERE status = 1) AS "won",
    count(*) FILTER (WHERE status = 0) AS "open",
    count(*) FILTER (WHERE status = 2) AS "lost"
  FROM public.activecampaign_deals
  WHERE cdate IS NOT NULL AND "group" IS NOT NULL
  GROUP BY 1, 2`;

// Deal counts BY MONTH (for the "AC pipeline" chart — months on the x axis, stacked
// Won/Open/Lost, same monthly design as Channel Summary). Bounded to MONTH_FLOOR so the
// axis lines up with the other monthly charts; FY-filtered client-side via each month's FY.
const PIPELINE_MONTH_SQL = `
  SELECT to_char(date_trunc('month', cdate), 'YYYY-MM') AS "month",
    count(*) FILTER (WHERE status = 1) AS "won",
    count(*) FILTER (WHERE status = 0) AS "open",
    count(*) FILTER (WHERE status = 2) AS "lost"
  FROM public.activecampaign_deals
  WHERE cdate IS NOT NULL AND cdate >= '${MONTH_FLOOR}'
  GROUP BY 1
  ORDER BY 1`;

// Marketing spend by Xero account, per FY (for the "Where the spend goes" chart).
const CATEGORIES_SQL = `
  SELECT ${FY('month')} AS "fyEnd", account_code AS "code",
         round(sum(amount))::numeric AS "amount"
  FROM public.marketing_channel_monthly
  GROUP BY 1, 2
  ORDER BY 1, 3 DESC`;

// MARKETING-ATTRIBUTED (WON) REVENUE, per FY — the "Marketing revenue" KPI card.
// Sum of WON revenue from four marketing-sourced buckets, DEDUPED by deal_id so a deal
// that qualifies for more than one AC bucket is counted once (precedence roas > organic >
// bureau/tailor); Exec X is a separate sheet source and always adds on top:
//   • roas          → paid-ad deals in the canonical public.roas_counted_deals view
//                     (status='won'; billed Xero engagement fee where invoiced, else value).
//   • organic       → organic-search-sourced deals on public.ga4_ac_contact_source
//                     (channel ~* 'organic', deal_status='won'; deal_value is AUD). FY from cdate.
//   • bureauTailor  → won deals flagged is_bureau / is_tailor on public.ac_deals_ytd
//                     (same identification as the Sales overview). FY from deal_created_at.
//                     NB ac_deals_ytd only covers Jul 2024+, so this reads 0 before FY25.
//   • execX         → public.exec_x_revenue (static load of the Executive X ROI Report sheet),
//                     summed by its event-date FY. Not an AC deal, so never deduped.
const MARKETING_REVENUE_SQL = `
  WITH roas AS (
    SELECT deal_id, fy_end,
           coalesce(xero_engagement_fee, value)::numeric AS rev, 1 AS pri, 'roas' AS bucket
    FROM public.roas_counted_deals
    WHERE status = 'won' AND deal_id IS NOT NULL
  ),
  organic AS (
    SELECT cs.deal_id, ${FY('cs.cdate')} AS fy_end,
           cs.deal_value::numeric AS rev, 2 AS pri, 'organic' AS bucket
    FROM public.ga4_ac_contact_source cs
    WHERE cs.channel ~* 'organic' AND cs.deal_status = 'won' AND cs.deal_id IS NOT NULL
  ),
  bt AS (
    SELECT ac_deal_id::text AS deal_id, ${FY('deal_created_at')} AS fy_end,
           deal_value::numeric AS rev, 3 AS pri, 'bureauTailor' AS bucket
    FROM public.ac_deals_ytd
    WHERE status = 'won' AND (is_bureau OR is_tailor)
  ),
  combined AS (
    SELECT * FROM roas UNION ALL SELECT * FROM organic UNION ALL SELECT * FROM bt
  ),
  dedup AS (
    SELECT DISTINCT ON (deal_id) deal_id, fy_end, rev, bucket
    FROM combined ORDER BY deal_id, pri
  ),
  deals_by_fy AS (
    SELECT fy_end,
      round(coalesce(sum(rev) FILTER (WHERE bucket = 'roas'), 0))::numeric         AS roas,
      round(coalesce(sum(rev) FILTER (WHERE bucket = 'organic'), 0))::numeric      AS organic,
      round(coalesce(sum(rev) FILTER (WHERE bucket = 'bureauTailor'), 0))::numeric AS bureau_tailor
    FROM dedup GROUP BY fy_end
  ),
  exec_x AS (
    SELECT fy_end, round(sum(revenue))::numeric AS exec_x
    FROM public.exec_x_revenue GROUP BY fy_end
  ),
  axis AS (SELECT fy_end FROM deals_by_fy UNION SELECT fy_end FROM exec_x)
  SELECT a.fy_end                                     AS "fyEnd",
         coalesce(d.roas, 0)                          AS "roas",
         coalesce(d.organic, 0)                       AS "organic",
         coalesce(d.bureau_tailor, 0)                 AS "bureauTailor",
         coalesce(e.exec_x, 0)                        AS "execX"
  FROM axis a
  LEFT JOIN deals_by_fy d ON d.fy_end = a.fy_end
  LEFT JOIN exec_x e      ON e.fy_end = a.fy_end
  ORDER BY a.fy_end`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

// FY END year a 'YYYY-MM' month belongs to.
function fyEndOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y + (m >= 7 ? 1 : 0);
}

function shape(r) {
  const revenue = num(r.revenue);       // null = no Xero P&L for this FY
  const totalSpend = num(r.totalSpend); // null = no marketing spend for this FY
  return {
    fy: r.fy,
    fyEnd: num(r.fyEnd),
    revenue,
    hasRevenue: revenue !== null,
    totalSpend,
    hasSpend: totalSpend !== null,
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
    totalSpend,
    hasSpend: anySpend,
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
      pipelineMonths: section([], pend),
      categories: section([], pend),
    };
  }

  const [fyRows, monthRows, pipeRows, pipeMonthRows, catRows, mrRows] = await Promise.all([
    q(BY_FY), q(BY_MONTH), q(PIPELINE_SQL), q(PIPELINE_MONTH_SQL), q(CATEGORIES_SQL),
    q(MARKETING_REVENUE_SQL),
  ]);
  const rows = fyRows.map(shape);

  // Attach marketing-attributed (won) revenue + its bucket breakdown to each FY row, so the
  // "Marketing revenue" card can be computed client-side from currentRow() (like the others).
  const EMPTY_MR = { roas: 0, organic: 0, bureauTailor: 0, execX: 0, total: 0 };
  const mrMap = {};
  mrRows.forEach((m) => {
    const parts = {
      roas: num(m.roas) || 0,
      organic: num(m.organic) || 0,
      bureauTailor: num(m.bureauTailor) || 0,
      execX: num(m.execX) || 0,
    };
    parts.total = parts.roas + parts.organic + parts.bureauTailor + parts.execX;
    mrMap[num(m.fyEnd)] = parts;
  });
  rows.forEach((r) => {
    const p = mrMap[r.fyEnd] || EMPTY_MR;
    r.marketingRevenue = p.total;
    r.marketingRevenueParts = p;
  });

  if (!rows.length) {
    const note = 'No data — seed xero_expenses_monthly (revenue) and run xero-channel-summary-sync (marketing spend).';
    const pend = { source: SRC, status: 'pending', note };
    return {
      asOf: new Date().toISOString(),
      defaultFy: null,
      total: null,
      rows: section([], pend),
      byMonth: section([], pend),
      pipelines: section([], pend),
      pipelineMonths: section([], pend),
      categories: section([], pend),
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

  // Deal counts by month (for the "AC pipeline" monthly chart); FY-filtered client-side.
  const pipelineMonths = pipeMonthRows.map((m) => ({
    month: m.month,
    fyEnd: fyEndOfMonth(m.month),
    won: num(m.won) || 0,
    open: num(m.open) || 0,
    lost: num(m.lost) || 0,
  }));

  // Marketing spend by account, per FY (for "Where the spend goes").
  const categories = catRows.map((c) => ({
    fyEnd: num(c.fyEnd),
    account: accountName(c.code),
    code: String(c.code),
    kind: 'marketing',
    amount: num(c.amount) || 0,
  }));

  const total = totalRow(rows);
  // Total-row marketing revenue = summed buckets across all FYs (so the "All years" card works).
  total.marketingRevenueParts = rows.reduce(
    (a, r) => {
      const p = r.marketingRevenueParts || EMPTY_MR;
      a.roas += p.roas; a.organic += p.organic; a.bureauTailor += p.bureauTailor; a.execX += p.execX;
      return a;
    },
    { roas: 0, organic: 0, bureauTailor: 0, execX: 0 },
  );
  total.marketingRevenueParts.total =
    total.marketingRevenueParts.roas + total.marketingRevenueParts.organic +
    total.marketingRevenueParts.bureauTailor + total.marketingRevenueParts.execX;
  total.marketingRevenue = total.marketingRevenueParts.total;

  // Default the page to the current FY if it's in the axis, else the latest FY present.
  const now = new Date();
  const curFy = now.getUTCFullYear() + (now.getUTCMonth() + 1 >= 7 ? 1 : 0);
  const defaultFy = fyEnds.includes(curFy) ? curFy : fyEnds[fyEnds.length - 1];

  const note =
    `${rows.length} FY(s) (${rows[0].fy}–${rows[rows.length - 1].fy}). ` +
    `Revenue = Xero P&L total income (ex-GST, whole business); spend = MARKETING expenses only ` +
    `(Xero accounts: Advertising — all vendors — plus the listed Website / Software / Printing / ` +
    `WrkPod-Staff vendors), ex-GST, live from Xero bank transactions and refreshed monthly; ` +
    `deals = all ActiveCampaign deals by created date. So "Return on spend" is return on MARKETING ` +
    `investment (whole-business revenue ÷ marketing spend), not a whole-business margin. FY22 and the ` +
    `current FY are partial, so their spend is below a full year — compare full years to full years.`;

  return {
    asOf: new Date().toISOString(),
    defaultFy,
    total,
    marketingRevenueSource: SRC_MR,
    rows: section(rows, { source: SRC, status: 'live', note }),
    byMonth: section(months, { source: SRC, status: 'live', note: null }),
    pipelines: section(pipelines, { source: SRC, status: 'live', note: null }),
    pipelineMonths: section(pipelineMonths, { source: SRC, status: 'live', note: null }),
    categories: section(categories, { source: SRC, status: 'live', note: null }),
  };
}
