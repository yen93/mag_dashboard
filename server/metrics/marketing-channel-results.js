// Marketing — Channel results (the "Spend & ROI" tab's bottom-right table).
//
// The channels in the brief's channel_list, per Australian FY (END-year, Jul–Jun).
// LIVE, computed at request time from Supabase. Where a channel has no known source
// for a column, that column is returned as the sentinel 'pending' (the page renders it
// as a red `pending` chip, DESIGN_GUIDE §8) — never a fabricated number.
//
//   • "Paid Ads"  → the canonical ROAS metric (server/metrics/roas.js).
//       Spend     = Ad cost excluding agency fees (Google Ads + Bing, ex-GST, Xero)
//       Enquiries = paid leads (won+lost+open) counted into ROAS (public.roas_counted_deals)
//       Bookings  = won paid deals
//       Revenue   = won paid revenue (billed Xero engagement fee where invoiced, else value)
//       ROAS total = won revenue ÷ Paid Ads spend (Google + Bing)
//
//   • "Executive X"  → public.exec_x_revenue (static load of the Executive X ROI sheet).
//       Bookings  = count of Exec X engagements (one row per client), Revenue = sum(revenue).
//       Spend     = the Xero "MAG program delivery expenses" account (code 376, cost of sales)
//                   per FY, from public.xero_pnl_accounts_fy. NB account 376 is MAG's SHARED
//                   program-delivery account (Geocon + all immersive programs, not Exec X only —
//                   Xero has no tracking category to split it), so this spend OVERCOUNTS Exec X
//                   and its ROAS total reads low. This is the owner's deliberate choice.
//       Enquiries = companies listed per season in the Exec X ROI sheet (attendees), summed per
//                   FY by the SESSION date (Spring Sep–Nov, Autumn Mar) — the SAME basis as the
//                   Nurture & Events page's EXEC_X table. STATIC (the sheet has no live feed).
//       ROAS total = revenue ÷ spend. Cost-per-enquiry is derived client-side. NB bookings/revenue
//                   are attributed by EVENT date, enquiries by SESSION date, so a later FY can
//                   show bookings with 0 same-FY enquiries.
//
//   • "Bureau" / "Tailor"  → the leads-by-source metric (marketing-leads-by-source.js —
//       ac_indirect_deals, split by is_tailor), so these rows reconcile EXACTLY with the
//       Leads & Bookings "By source" table.
//       Enquiries = leads for that source, Bookings = won, Revenue = won revenue (AUD).
//       Spend / Cost-per-enquiry / ROAS total are not applicable for these channels → 'N/A'.
//
//   • "Marketing EDM"  → 0 across all columns (pending tracking process).
//
// All channels are returned per FY plus an "all years" total, so the page's FY toggle can
// filter client-side. Cost-per-enquiry is derived on the client (spend ÷ enquiries; 'N/A' or
// 'pending' whenever spend or enquiries is 'N/A' or 'pending').

import { q, supabaseConfigured } from '../providers/supabase.js';
import { getRoas } from './roas.js';
import { getMarketingLeadsBySource } from './marketing-leads-by-source.js';

export const CHANNELS = [
  'Paid Ads', 'Executive X', 'Bureau', 'Tailor', 'Marketing EDM',
];

// Sentinel for a column with no known data source for a given channel.
const PENDING = 'pending';
const NA = 'N/A';

const SRC =
  'Live (Supabase): Paid Ads row from the ROAS metric (roas_counted_deals + Xero ad spend — ' +
  'Google + Bing, excluding agency fees); Executive X bookings+revenue from exec_x_revenue (Exec X ROI ' +
  'sheet), spend from the Xero "MAG program delivery expenses" account (code 376, cost of ' +
  'sales) per FY via xero_pnl_accounts_fy — a shared all-programs account, so it overcounts ' +
  'Exec X; enquiries = companies listed per season in the Exec X ROI sheet (static, by session ' +
  'FY); Bureau/Tailor from the leads-by-source metric (ac_indirect_deals, Spend/Cost per enquiry/ROAS total = N/A); ' +
  'Marketing EDM = 0 (pending tracking process).';

const EXEC_X_SQL = `
  SELECT fy_end AS "fyEnd",
         count(*)                  AS "bookings",
         round(sum(revenue))::numeric AS "revenue"
  FROM public.exec_x_revenue
  GROUP BY fy_end
  ORDER BY fy_end`;

// Exec X spend = the Xero "MAG program delivery expenses" account (code 376), per FY.
const PROGRAM_DELIVERY_SQL = `
  SELECT fy_end AS "fyEnd",
         round(sum(amount))::numeric AS "spend"
  FROM public.xero_pnl_accounts_fy
  WHERE account_name = 'MAG program delivery expenses'
  GROUP BY fy_end
  ORDER BY fy_end`;

// Exec X ENQUIRIES = companies (attendees) listed per season in the "Executive X ROI Report"
// Google Sheet, summed per FY by the SESSION date (Spring Sep–Nov, Autumn Mar). STATIC — the
// sheet has no live feed, so this is a hardcode (keep in sync with public/nurture_events.html
// EXEC_X `attendees`; re-seed when the sheet's season tabs change). Verified 2026-11-10:
//   FY24 = Spring 2023 (12) + Autumn 2024 (9)  = 21
//   FY25 = Spring 2024 (11) + Autumn 2025 (12) = 23
//   FY26 = Spring 2025 (13) + Autumn 2026 (10) = 23
const EXEC_X_ENQUIRIES_BY_FY = { 2024: 21, 2025: 23, 2026: 23 };
const EXEC_X_ENQUIRIES_TOTAL = Object.values(EXEC_X_ENQUIRIES_BY_FY).reduce((a, b) => a + b, 0);

const num = (v) => (v === null || v === undefined ? null : Number(v));

// Shape the Paid Ads channel from one ROAS per-FY row (Google + Bing spend, excluding agency fees).
function paidFrom(r) {
  if (!r) return { spend: 0, enquiries: 0, bookings: 0, revenue: 0, roasTotal: null };
  const spend = (r.googleSpend || 0) + (r.bingSpend || 0);
  const revenue = r.wonRevenue || 0;
  return {
    spend,
    enquiries: r.leads || 0,
    bookings: r.won || 0,
    revenue,
    roasTotal: spend ? revenue / spend : null,
  };
}

// Executive X — bookings + revenue from exec_x_revenue; spend from the Xero "MAG program
// delivery expenses" account (code 376) for that FY; enquiries = companies listed that FY in
// the Exec X ROI sheet (0 when no session that FY). ROAS total = revenue ÷ spend.
function execXFrom(e, spend, enquiries) {
  const sp = (spend === null || spend === undefined) ? PENDING : num(spend);
  const revenue = e ? num(e.revenue) || 0 : 0;
  return {
    spend: sp,
    enquiries: (enquiries == null) ? 0 : enquiries,
    bookings: e ? num(e.bookings) || 0 : 0,
    revenue,
    roasTotal: (typeof sp === 'number' && sp > 0) ? revenue / sp : (sp === 0 ? null : PENDING),
  };
}

// Bureau / Tailor — enquiries, bookings and won revenue per FY from the leads-by-source
// metric (so they reconcile with the Leads & Bookings "By source" table). Spend /
// cost-per-enquiry / ROAS total are 'N/A' for these channels.
// `fyEnd` null → aggregate across all years.
function indirectFrom(leads, source, fyEnd) {
  const rows = leads.filter((l) => l.source === source && (fyEnd == null || l.fyEnd === fyEnd));
  const won = rows.filter((l) => l.won);
  return {
    spend: NA,
    enquiries: rows.length,
    bookings: won.length,
    revenue: Math.round(won.reduce((a, l) => a + (num(l.value) || 0), 0)),
    roasTotal: NA,
  };
}

// Marketing EDM — 0 across all columns (pending tracking process).
function edmChannel() {
  return {
    spend: 0, enquiries: 0, costPerEnq: 0, bookings: 0,
    revenue: 0, roasTotal: 0,
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

  const [roas, execRows, deliveryRows, lbs] = await Promise.all([
    getRoas(), q(EXEC_X_SQL), q(PROGRAM_DELIVERY_SQL), getMarketingLeadsBySource(),
  ]);
  const paidRows = (roas.rows && roas.rows.data) || [];
  const paidByFy = {};
  paidRows.forEach((r) => { paidByFy[r.fyEnd] = r; });
  const execByFy = {};
  execRows.forEach((e) => { execByFy[num(e.fyEnd)] = e; });
  // Exec X spend per FY, from the Xero "MAG program delivery expenses" account (code 376).
  const deliveryByFy = {};
  deliveryRows.forEach((d) => { deliveryByFy[num(d.fyEnd)] = num(d.spend); });

  // Bureau / Tailor come from the per-lead rows of the leads-by-source metric.
  const INDIRECT = ['Bureau', 'Tailor'];
  const leads = ((lbs && lbs.leads) || []).filter((l) => INDIRECT.includes(l.source));
  const leadFyEnds = leads.map((l) => l.fyEnd);

  // FY axis = FYs that appear in any channel.
  const fyEnds = [...new Set([
    ...paidRows.map((r) => r.fyEnd),
    ...execRows.map((e) => num(e.fyEnd)),
    ...deliveryRows.map((d) => num(d.fyEnd)),
    ...leadFyEnds,
  ])]
    .filter((v) => v != null)
    .sort((a, b) => a - b);

  const rows = fyEnds.map((fyEnd) => ({
    fyEnd,
    fy: 'FY' + String(fyEnd).slice(-2),
    paid: paidFrom(paidByFy[fyEnd]),
    execX: execXFrom(execByFy[fyEnd], deliveryByFy[fyEnd], EXEC_X_ENQUIRIES_BY_FY[fyEnd]),
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
  const execSpendTotal = deliveryRows.reduce((a, d) => a + (num(d.spend) || 0), 0);
  const total = {
    fyEnd: null,
    fy: 'All',
    paid: paidFrom(roas.total),
    execX: execXFrom(execTotal, execSpendTotal, EXEC_X_ENQUIRIES_TOTAL),
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
      `Paid Ads = ROAS metric (Google+Bing ad cost excluding agency fees vs won paid revenue); ` +
      `Executive X = exec_x_revenue (bookings+revenue), spend from the Xero "MAG program ` +
      `delivery expenses" account (code 376, a shared all-programs account — overcounts Exec X), ` +
      `enquiries = companies listed per season in the Exec X ROI sheet (static, by session FY); ` +
      `Bureau/Tailor = leads-by-source (enquiries, bookings, won revenue; Spend/Cost per enquiry/ROAS total = N/A); ` +
      `Marketing EDM = 0 (pending tracking process).`
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
