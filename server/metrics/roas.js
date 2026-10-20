// ROAS (Return on Ad Spend) — Google Ads performance, year on year (calendar year).
//
// Reads a PRE-COMPUTED cache table, public.roas_year_on_year, which mirrors the
// "Year on Year" tab of the Google Sheet "MAG Marketing ROAS Report – YTD -
// FY24-27 deal". That sheet blends three sources the live DB can't reproduce:
// the previous manager's 2022–2024 lead log, the 2025+ CRM rebuild, and typed-in
// ad spend. The dashboard makes NO source calls at request time — it SELECTs this
// one table (refreshed by the roas-year-on-year-sync Claude routine), so it stays
// fast and never fails on an upstream outage.
//
// The "All years" total row is derived here (not stored) by summing the year rows.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'MAG Marketing ROAS Report (Google Sheet → Supabase cache)';

const SELECT = `
  SELECT
    cal_yr          AS "year",
    period_label    AS "periodLabel",
    won_amount      AS "wonAmount",
    lost_amount     AS "lostAmount",
    open_amount     AS "openAmount",
    won_leads       AS "wonLeads",
    lost_leads      AS "lostLeads",
    open_leads      AS "openLeads",
    leads           AS "leads",
    win_rate        AS "winRate",
    ad_spend        AS "adSpend",
    won_revenue     AS "wonRevenue",
    roi_dollars     AS "roiDollars",
    roi_pct         AS "roiPct",
    roas            AS "roas",
    per_lead_value  AS "perLeadValue",
    counted_method  AS "countedMethod",
    target_roas     AS "targetRoas"
  FROM public.roas_year_on_year
  ORDER BY cal_yr`;

// Cast the numeric/int columns coming back from pg (numeric arrives as a string).
function numify(r) {
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    year: n(r.year),
    periodLabel: r.periodLabel,
    wonAmount: n(r.wonAmount),
    lostAmount: n(r.lostAmount),
    openAmount: n(r.openAmount),
    wonLeads: n(r.wonLeads),
    lostLeads: n(r.lostLeads),
    openLeads: n(r.openLeads),
    leads: n(r.leads),
    winRate: n(r.winRate),
    adSpend: n(r.adSpend),
    wonRevenue: n(r.wonRevenue),
    roiDollars: n(r.roiDollars),
    roiPct: n(r.roiPct),
    roas: n(r.roas),
    perLeadValue: n(r.perLeadValue),
    countedMethod: r.countedMethod,
    targetRoas: n(r.targetRoas),
  };
}

// "All years" total — derived by summing the year rows (ratios recomputed, not summed).
function totalRow(rows) {
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const wonAmount = sum('wonAmount');
  const lostAmount = sum('lostAmount');
  const openAmount = sum('openAmount');
  const wonLeads = sum('wonLeads');
  const lostLeads = sum('lostLeads');
  const openLeads = sum('openLeads');
  const leads = sum('leads');
  const adSpend = sum('adSpend');
  const wonRevenue = sum('wonRevenue');
  const roiDollars = wonRevenue - adSpend;
  return {
    year: null,
    periodLabel: 'All years',
    label: 'All years',
    wonAmount, lostAmount, openAmount,
    wonLeads, lostLeads, openLeads, leads,
    winRate: leads ? wonLeads / leads : null,
    adSpend, wonRevenue, roiDollars,
    roiPct: adSpend ? roiDollars / adSpend : null,
    roas: adSpend ? wonRevenue / adSpend : null,
    perLeadValue: leads ? wonRevenue / leads : null,
    countedMethod: '',
    targetRoas: rows.length ? rows[rows.length - 1].targetRoas : 2,
  };
}

export async function getRoas() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      target: 2,
      total: null,
      rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
    };
  }

  const raw = await q(SELECT);
  const rows = raw.map(numify);

  if (!rows.length) {
    return {
      asOf: new Date().toISOString(),
      target: 2,
      total: null,
      rows: section([], { source: SRC, status: 'pending', note: 'ROAS cache is empty — run the roas-year-on-year-sync routine to populate public.roas_year_on_year from the Google Sheet.' }),
    };
  }

  const target = rows[rows.length - 1].targetRoas || 2;
  const total = totalRow(rows);
  const note = `${rows.length} calendar years (${rows[0].year}–${rows[rows.length - 1].year}). All-years ROAS ${total.roas.toFixed(2)}× vs ${target.toFixed(2)}× target.`;

  return {
    asOf: new Date().toISOString(),
    target,
    total,
    rows: section(rows, { source: SRC, status: 'live', note }),
  };
}
