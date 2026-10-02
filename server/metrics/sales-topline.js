// Sales Top-Line KPIs — the dashboard "Sales" page (MAG_Sales_Metrics dev_sheet
// rows 2–8, the "Top-Line Header" group).
//
// Like the Conferences/Invoices pages, this reads a PRE-COMPUTED cache table,
// public.sales_topline, filled WEEKLY (Mon 06:00 PH) by the `sales-topline-sync`
// Claude routine (see routines/sales-topline-sync.md). The dashboard makes NO
// source calls at request time — it just SELECTs the table, so it stays fast and
// never fails on an upstream outage.
//
// Computed today (from data already in Supabase):
//   • total_income  — invoice_tracking (Xero mirror), AUD, YTD + 12-month trend
//   • bureau        — LIV pipeline (activecampaign_deals."group"='3') stage '113'
//   • tailor        — The Tailor pipeline (activecampaign_deals."group"='7')
// Still "needs setup" — they rely on ActiveCampaign custom fields/tags not yet
// mirrored to Supabase (the weekly routine will backfill them later):
//   • direct_indirect_split — AC "Deal Source?" field
//   • speaking_enquiries    — AC "[SALES] Inbound Enquiry" tag
//   • inbound / outbound    — AC "Inbound/ Outbound?" field

import { q, supabaseConfigured } from '../providers/supabase.js';
import { live, pending, section } from '../lib/metric.js';

const SRC_INCOME = 'Xero → invoice_tracking (Supabase cache)';
const SRC_AC = 'ActiveCampaign (Supabase cache)';
const SRC_AC_TODO = 'ActiveCampaign';

const SELECT = `
  SELECT metric,
         to_char(bucket, 'YYYY-MM') AS month,
         dimension,
         value::float8              AS value,
         unit
  FROM public.sales_topline
  ORDER BY metric, bucket`;

export async function getSalesTopline() {
  if (!supabaseConfigured()) return notConfigured();

  const rows = await q(SELECT);
  const of = (m) => rows.filter((r) => r.metric === m);
  const series = (m) => of(m).filter((r) => r.dimension === '').map((r) => ({ month: r.month, value: r.value }));
  const curMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  const thisMonth = (arr) => { const r = arr.find((x) => x.month === curMonth); return r ? r.value : 0; };

  // --- Total income (YTD figure + prior-year delta + monthly trend) ---
  const incRows = of('total_income');
  const ytd = incRows.find((r) => r.dimension === 'ytd');
  const prev = incRows.find((r) => r.dimension === 'ytd_prev');
  const incomeMonthly = series('total_income');
  const incDelta = ytd && prev && prev.value > 0 ? Math.round(((ytd.value - prev.value) / prev.value) * 100) : null;

  // --- Bureau / Tailor monthly new-deal counts ---
  const bureau = series('bureau');
  const tailor = series('tailor');

  const kpis = {
    totalIncome: ytd
      ? live(ytd.value, 'currency', { source: SRC_INCOME, delta: incDelta, note: 'Sum of AUD invoice totals this calendar year (invoice_tracking).' })
      : pending('currency', { source: SRC_INCOME, note: 'Income cache not populated yet — the weekly sales-topline-sync job has not run.' }),
    bureau: bureau.length
      ? live(thisMonth(bureau), 'count', { source: SRC_AC, note: 'New deals entering the BUREAU ENQUIRY stage (LIV pipeline) this month, by created date.' })
      : pending('count', { source: SRC_AC, note: 'No bureau data in cache yet.' }),
    tailor: tailor.length
      ? live(thisMonth(tailor), 'count', { source: SRC_AC, note: 'New deals in The Tailor pipeline this month, by created date.' })
      : pending('count', { source: SRC_AC, note: 'No tailor data in cache yet.' }),
    speakingEnquiries: pending('count', { source: SRC_AC_TODO, note: 'Needs the ActiveCampaign "[SALES] Inbound Enquiry" tag, not mirrored to Supabase yet.' }),
  };

  const incomeTrend = incomeMonthly.length
    ? section(incomeMonthly, { source: SRC_INCOME, status: 'live', note: 'Monthly AUD invoice totals (last 12 months).' })
    : section([], { source: SRC_INCOME, status: 'pending', note: 'Income cache not populated yet.' });

  const enquiryTrend = (bureau.length || tailor.length)
    ? section(mergeTrend(bureau, tailor), { source: SRC_AC, status: 'live', note: 'New deals per month — BUREAU ENQUIRY stage vs The Tailor pipeline (by created date).' })
    : section([], { source: SRC_AC, status: 'pending', note: 'No pipeline data in cache yet.' });

  const splitBreakdown = section([], { source: SRC_AC_TODO, status: 'pending', note: 'Direct vs Indirect income needs the ActiveCampaign "Deal Source?" field, not mirrored to Supabase yet.' });
  const inboundOutbound = section([], { source: SRC_AC_TODO, status: 'pending', note: 'Inbound vs Outbound needs the ActiveCampaign "Inbound/ Outbound?" field, not mirrored to Supabase yet.' });

  return { asOf: new Date().toISOString(), kpis, incomeTrend, enquiryTrend, splitBreakdown, inboundOutbound };
}

// Combine the two monthly series onto one month axis: [{month, bureau, tailor}].
function mergeTrend(bureau, tailor) {
  const bMap = Object.fromEntries(bureau.map((b) => [b.month, b.value]));
  const tMap = Object.fromEntries(tailor.map((t) => [t.month, t.value]));
  const months = Array.from(new Set([...bureau.map((b) => b.month), ...tailor.map((t) => t.month)])).sort();
  return months.map((m) => ({ month: m, bureau: bMap[m] || 0, tailor: tMap[m] || 0 }));
}

function notConfigured() {
  const note = 'Supabase not configured (set SUPABASE_DB_URL).';
  return {
    asOf: new Date().toISOString(),
    kpis: {
      totalIncome: pending('currency', { source: SRC_INCOME, note }),
      bureau: pending('count', { source: SRC_AC, note }),
      tailor: pending('count', { source: SRC_AC, note }),
      speakingEnquiries: pending('count', { source: SRC_AC_TODO, note }),
    },
    incomeTrend: section([], { source: SRC_INCOME, status: 'pending', note }),
    enquiryTrend: section([], { source: SRC_AC, status: 'pending', note }),
    splitBreakdown: section([], { source: SRC_AC_TODO, status: 'pending', note }),
    inboundOutbound: section([], { source: SRC_AC_TODO, status: 'pending', note }),
  };
}
