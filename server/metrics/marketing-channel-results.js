// Marketing — Channel results (the "Spend & ROI" tab's bottom-right table).
//
// The channels in the brief's channel_list, per Australian FY (END-year, Jul–Jun).
// LIVE, computed at request time from Supabase. Where a channel has no known source
// for a column, that column is returned as the sentinel 'pending' (the page renders it
// as a red `pending` chip, DESIGN_GUIDE §8) — never a fabricated number.
//
//   • "Paid (Google, Bing, Agency)"  → the canonical ROAS metric (server/metrics/roas.js).
//       Spend     = All-in ad cost (Google Ads + Bing + Simple Digital/agency, ex-GST, Xero)
//       Enquiries = paid leads (won+lost+open) counted into ROAS (public.roas_counted_deals)
//       Bookings  = won paid deals
//       Revenue   = won paid revenue (billed Xero engagement fee where invoiced, else value)
//       ROAS total/ads = roasAllin / roasGoogle (won revenue ÷ all-in / ÷ Google-only cost)
//
//   • "Executive X"  → public.exec_x_revenue (static load of the Executive X ROI sheet).
//       Bookings  = count of Exec X engagements (one row per client), Revenue = sum(revenue).
//       Spend / Enquiries / Cost-per-enquiry / ROAS are not tracked for Exec X → 'pending'.
//
//   • "Bureau" / "Tailor"  → the leads-by-source metric (marketing-leads-by-source.js —
//       ac_indirect_deals, split by is_tailor), so these rows reconcile EXACTLY with the
//       Leads & Bookings "By source" table.
//       Enquiries = leads for that source, Bookings = won, Revenue = won revenue (AUD).
//       Spend / Cost-per-enquiry / ROAS are not tracked for these channels → 'pending'.
//
//   • "Marketing EDM"  → not yet attributed to deals/revenue → every column 'pending'.
//
// All channels are returned per FY plus an "all years" total, so the page's FY toggle can
// filter client-side. Cost-per-enquiry is derived on the client (spend ÷ enquiries; 'pending'
// whenever spend or enquiries is 'pending').

import { q, supabaseConfigured } from '../providers/supabase.js';
import { getRoas } from './roas.js';
import { getMarketingLeadsBySource } from './marketing-leads-by-source.js';

export const CHANNELS = [
  'Paid (Google, Bing, Agency)', 'Executive X', 'Bureau', 'Tailor', 'Marketing EDM',
];

// Sentinel for a column with no known data source for a given channel.
const PENDING = 'pending';

const SRC =
  'Live (Supabase): Paid row from the ROAS metric (roas_counted_deals + Xero ad spend — ' +
  'Google/Bing/Simple Digital); Executive X from exec_x_revenue (Exec X ROI sheet); ' +
  'Bureau/Tailor from the leads-by-source metric (ac_indirect_deals); ' +
  'Marketing EDM not yet tracked. Untracked columns return "pending".';

const EXEC_X_SQL = `
  SELECT fy_end AS "fyEnd",
         count(*)                  AS "bookings",
         round(sum(revenue))::numeric AS "revenue"
  FROM public.exec_x_revenue
  GROUP BY fy_end
  ORDER BY fy_end`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

// Shape the Paid channel from one ROAS per-FY row.
function paidFrom(r) {
  if (!r) return { spend: 0, enquiries: 0, bookings: 0, revenue: 0, roasTotal: null, roasAds: null };
  return {
    spend: r.totalCost || 0,
    enquiries: r.leads || 0,
    bookings: r.won || 0,
    revenue: r.wonRevenue || 0,
    roasTotal: r.roasAllin != null ? r.roasAllin : (r.totalCost ? (r.wonRevenue || 0) / r.totalCost : null),
    roasAds: r.roasGoogle != null ? r.roasGoogle : (r.googleSpend ? (r.wonRevenue || 0) / r.googleSpend : null),
  };
}

// Executive X has no spend / enquiry funnel / ROAS — only bookings + revenue.
// The untracked columns are 'pending' (not "—"): they have no source, not a zero value.
function execXFrom(e) {
  return {
    spend: PENDING,
    enquiries: PENDING,
    bookings: e ? num(e.bookings) || 0 : 0,
    revenue: e ? num(e.revenue) || 0 : 0,
    roasTotal: PENDING,
    roasAds: PENDING,
  };
}

// Bureau / Tailor — enquiries, bookings and won revenue per FY from the leads-by-source
// metric (so they reconcile with the Leads & Bookings "By source" table). Spend /
// cost-per-enquiry / ROAS are not tracked for these channels → 'pending'.
// `fyEnd` null → aggregate across all years.
function indirectFrom(leads, source, fyEnd) {
  const rows = leads.filter((l) => l.source === source && (fyEnd == null || l.fyEnd === fyEnd));
  const won = rows.filter((l) => l.won);
  return {
    spend: PENDING,
    enquiries: rows.length,
    bookings: won.length,
    revenue: Math.round(won.reduce((a, l) => a + (num(l.value) || 0), 0)),
    roasTotal: PENDING,
    roasAds: PENDING,
  };
}

// Marketing EDM — no deal/revenue attribution source yet → every column 'pending'.
function edmChannel() {
  return {
    spend: PENDING, enquiries: PENDING, bookings: PENDING,
    revenue: PENDING, roasTotal: PENDING, roasAds: PENDING,
  };
}

export async function getMarketingChannelResults() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      channels: CHANNELS,
      defaultFy: null,
      rows: [],
      total: null,
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured (set SUPABASE_DB_URL).' },
    };
  }

  const [roas, execRows, lbs] = await Promise.all([getRoas(), q(EXEC_X_SQL), getMarketingLeadsBySource()]);
  const paidRows = (roas.rows && roas.rows.data) || [];
  const paidByFy = {};
  paidRows.forEach((r) => { paidByFy[r.fyEnd] = r; });
  const execByFy = {};
  execRows.forEach((e) => { execByFy[num(e.fyEnd)] = e; });

  // Bureau / Tailor come from the per-lead rows of the leads-by-source metric.
  const INDIRECT = ['Bureau', 'Tailor'];
  const leads = ((lbs && lbs.leads) || []).filter((l) => INDIRECT.includes(l.source));
  const leadFyEnds = leads.map((l) => l.fyEnd);

  // FY axis = FYs that appear in any channel.
  const fyEnds = [...new Set([
    ...paidRows.map((r) => r.fyEnd),
    ...execRows.map((e) => num(e.fyEnd)),
    ...leadFyEnds,
  ])]
    .filter((v) => v != null)
    .sort((a, b) => a - b);

  const rows = fyEnds.map((fyEnd) => ({
    fyEnd,
    fy: 'FY' + String(fyEnd).slice(-2),
    paid: paidFrom(paidByFy[fyEnd]),
    execX: execXFrom(execByFy[fyEnd]),
    bureau: indirectFrom(leads, 'Bureau', fyEnd),
    tailor: indirectFrom(leads, 'Tailor', fyEnd),
    edm: edmChannel(),
  }));

  // All-years total — paid from the ROAS total row (ratios recomputed there); Exec X summed;
  // Bureau/Tailor/Organic aggregated across all FYs.
  const execTotal = {
    bookings: execRows.reduce((a, e) => a + (num(e.bookings) || 0), 0),
    revenue: execRows.reduce((a, e) => a + (num(e.revenue) || 0), 0),
  };
  const total = {
    fyEnd: null,
    fy: 'All',
    paid: paidFrom(roas.total),
    execX: execXFrom(execTotal),
    bureau: indirectFrom(leads, 'Bureau', null),
    tailor: indirectFrom(leads, 'Tailor', null),
    edm: edmChannel(),
  };

  // Default to the current AU FY if present, else the latest.
  const now = new Date();
  const curFy = now.getUTCFullYear() + (now.getUTCMonth() + 1 >= 7 ? 1 : 0);
  const defaultFy = fyEnds.includes(curFy) ? curFy : (fyEnds[fyEnds.length - 1] ?? null);

  const note = rows.length
    ? `${CHANNELS.length} channels per FY (${rows[0].fy}–${rows[rows.length - 1].fy}). ` +
      `Paid = ROAS metric (All-in Google+Bing+agency cost vs won paid revenue); ` +
      `Executive X = exec_x_revenue; Bureau/Tailor = leads-by-source (enquiries, ` +
      `bookings, won revenue); Marketing EDM not yet tracked. Untracked columns = "pending".`
    : 'No channel results yet.';

  return {
    asOf: new Date().toISOString(),
    channels: CHANNELS,
    defaultFy,
    rows,
    total,
    meta: { status: rows.length ? 'live' : 'pending', source: SRC, note },
  };
}
