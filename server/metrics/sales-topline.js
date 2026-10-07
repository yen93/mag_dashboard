// Sales Top-Line + Conference KPIs — the dashboard "Sales" page.
// Mirrors the MAG_Sales_Metrics Google Sheet `dev_sheet` tab arrangement:
//   1. Top-Line Header        (rows 2–8)
//   2. Total Sales / Enquiries (rows 10–12)
//   3. CONFERENCE › Overview   (rows 15–20)
//
// Like the Conferences/Invoices pages, this reads a PRE-COMPUTED cache table,
// public.sales_topline, filled WEEKLY (Mon 06:00 PH) by the `sales-topline-sync`
// Claude routine (see routines/sales-topline-sync.md). The dashboard makes NO
// source calls at request time — it just SELECTs the table, so it stays fast and
// never fails on an upstream outage.
//
// LIVE today (data already in Supabase):
//   • total_income  — invoice_tracking (Xero mirror), AUD, YTD + 12-month trend
//   • bureau        — LIV pipeline (activecampaign_deals."group"='3') stage '113'
//   • tailor        — The Tailor pipeline (activecampaign_deals."group"='7')
//   • deals_won / deals_lost / won_value — LIV pipeline, status 1/2, by mdate
//   • demos_booked  — LIV deals with ac_custom_fields."Demo date?" set
//   (win_rate + avg_deal_value are derived from the above in this module)
// Still "needs setup" — they rely on ActiveCampaign custom fields/tags not yet
// mirrored to Supabase (the weekly routine will backfill them later):
//   • direct/indirect split + leads — AC "Deal Source?" field
//   • speaking_enquiries            — AC "[SALES] Inbound Enquiry" tag
//   • inbound / outbound            — AC "Inbound/ Outbound?" field
//   • conference vs MAG income split, MAG Revenue, book-sale upsell (need detail)

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
  const ytdOf = (m) => { const r = of(m).find((x) => x.dimension === 'ytd'); return r ? r.value : null; };
  const curMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  const thisMonth = (arr) => { const r = arr.find((x) => x.month === curMonth); return r ? r.value : 0; };

  // --- Total income (YTD figure + prior-year delta + monthly trend) ---
  const incRows = of('total_income');
  const ytdInc = incRows.find((r) => r.dimension === 'ytd');
  const prevInc = incRows.find((r) => r.dimension === 'ytd_prev');
  const incomeMonthly = fill12(series('total_income'));
  const incDelta = ytdInc && prevInc && prevInc.value > 0 ? Math.round(((ytdInc.value - prevInc.value) / prevInc.value) * 100) : null;

  // --- Bureau / Tailor monthly new-deal counts ---
  const bureau = series('bureau');
  const tailor = series('tailor');

  // --- Conference Overview (LIV pipeline) ---
  const wonSeries = series('deals_won');
  const lostSeries = series('deals_lost');
  const wonValueSeries = series('won_value');
  const demoSeries = series('demos_booked');

  const wonYtd = ytdOf('deals_won');
  const lostYtd = ytdOf('deals_lost');
  const wonValueYtd = ytdOf('won_value');
  const demosYtd = ytdOf('demos_booked');
  const haveConf = wonSeries.length > 0;

  const winRateYtd = wonYtd != null && lostYtd != null && (wonYtd + lostYtd) > 0
    ? Math.round((wonYtd / (wonYtd + lostYtd)) * 100) : null;
  const avgDealValue = wonYtd && wonValueYtd != null && wonYtd > 0
    ? Math.round(wonValueYtd / wonYtd) : null;

  // ================= 1. TOP-LINE HEADER =================
  const kpis = {
    totalIncome: ytdInc
      ? live(ytdInc.value, 'currency', { source: SRC_INCOME, delta: incDelta, note: 'Sum of AUD invoice totals this calendar year (invoice_tracking).' })
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
    ? section(mergeTrend([['bureau', bureau], ['tailor', tailor]]), { source: SRC_AC, status: 'live', note: 'New deals per month — BUREAU ENQUIRY stage vs The Tailor pipeline (by created date).' })
    : section([], { source: SRC_AC, status: 'pending', note: 'No pipeline data in cache yet.' });

  const splitBreakdown = section([], { source: SRC_AC_TODO, status: 'pending', note: 'Direct vs Indirect income needs the ActiveCampaign "Deal Source?" field, not mirrored to Supabase yet.' });
  const inboundOutbound = section([], { source: SRC_AC_TODO, status: 'pending', note: 'Inbound vs Outbound needs the ActiveCampaign "Inbound/ Outbound?" field, not mirrored to Supabase yet.' });

  // ================= 2. TOTAL SALES / ENQUIRIES =================
  const sales = {
    totalIncome: kpis.totalIncome,
    conferenceIncome: pending('currency', { source: SRC_INCOME, note: 'Conference income needs invoice_tracking rows matched to LIV pipeline deals — matching key not mirrored yet.' }),
    magExperiences: pending('currency', { source: SRC_INCOME, note: 'MAG Experiences income — source breakdown still being defined (dev_sheet blocker: "need more details").' }),
  };

  // ================= 3. CONFERENCE › OVERVIEW =================
  const conference = {
    kpis: {
      dealsWon: haveConf
        ? live(wonYtd || 0, 'count', { source: SRC_AC, note: 'Deals won (LIV pipeline) year to date, by close month.' })
        : pending('count', { source: SRC_AC, note: 'No won-deal data in cache yet.' }),
      winRate: winRateYtd != null
        ? live(winRateYtd, 'percent', { source: SRC_AC, note: 'YTD won / (won + lost) in the LIV pipeline.' })
        : pending('percent', { source: SRC_AC, note: 'No win/loss data in cache yet.' }),
      avgDealValue: avgDealValue != null
        ? live(avgDealValue, 'currency', { source: SRC_AC, note: 'YTD won deal value ÷ deals won (LIV, CRM-contracted value, AUD). Billed revenue would come from Xero.' })
        : pending('currency', { source: SRC_AC, note: 'No won-value data in cache yet.' }),
      demosBooked: demosYtd != null
        ? live(demosYtd || 0, 'count', { source: SRC_AC, note: 'LIV deals with a "Demo date?" set, year to date.' })
        : pending('count', { source: SRC_AC, note: 'No demo data in cache yet.' }),
    },
    dealsWonTrend: haveConf
      ? section(fill12(wonSeries), { source: SRC_AC, status: 'live', note: 'Deals won per month (LIV pipeline, by close month).' })
      : section([], { source: SRC_AC, status: 'pending', note: 'No won-deal data in cache yet.' }),
    winRateTrend: (wonSeries.length || lostSeries.length)
      ? section(winRateTrend(wonSeries, lostSeries), { source: SRC_AC, status: 'live', note: 'Monthly win rate — won / (won + lost), LIV pipeline.' })
      : section([], { source: SRC_AC, status: 'pending', note: 'No win/loss data in cache yet.' }),
    wonRevenueTrend: wonValueSeries.length
      ? section(fill12(wonValueSeries), { source: SRC_AC, status: 'live', note: 'Won deal value per month (LIV pipeline, AUD, CRM-contracted).' })
      : section([], { source: SRC_AC, status: 'pending', note: 'No won-value data in cache yet.' }),
    demosTrend: demoSeries.length
      ? section(fill12(demoSeries), { source: SRC_AC, status: 'live', note: 'Demos booked per month (LIV deals with a "Demo date?").' })
      : section([], { source: SRC_AC, status: 'pending', note: 'No demo data in cache yet.' }),
    directIndirectShare: section([], { source: SRC_AC_TODO, status: 'pending', note: 'Direct vs Indirect share of income needs the AC "Deal Source?" field + invoice match — not mirrored yet.' }),
    directIndirectLeads: section([], { source: SRC_AC_TODO, status: 'pending', note: 'Direct vs Indirect lead counts need the AC "Deal Source?" field, not mirrored yet.' }),
  };

  return {
    asOf: new Date().toISOString(),
    // top-line (kept flat for backward compatibility with existing callers)
    kpis, incomeTrend, enquiryTrend, splitBreakdown, inboundOutbound,
    // new sections
    sales, conference,
  };
}

// Combine N monthly series onto one month axis: [{month, <name>:value, ...}].
// pairs: [[name, series], ...]
function mergeTrend(pairs) {
  const months = Array.from(new Set(pairs.flatMap(([, s]) => s.map((r) => r.month)))).sort();
  const maps = pairs.map(([name, s]) => [name, Object.fromEntries(s.map((r) => [r.month, r.value]))]);
  return months.map((m) => {
    const row = { month: m };
    maps.forEach(([name, map]) => { row[name] = map[m] || 0; });
    return row;
  });
}

// Monthly win-rate series [{month, value(%)}]; null where no closed deals that month.
function winRateTrend(won, lost) {
  const wMap = Object.fromEntries(won.map((r) => [r.month, r.value]));
  const lMap = Object.fromEntries(lost.map((r) => [r.month, r.value]));
  const months = Array.from(new Set([...won, ...lost].map((r) => r.month))).sort();
  return months.map((m) => {
    const w = wMap[m] || 0, l = lMap[m] || 0;
    return { month: m, value: (w + l) > 0 ? Math.round((w / (w + l)) * 100) : null };
  });
}

// Left-join a monthly series onto a complete trailing-12-month axis (fills 0s so
// trends have no gaps). Input/output: [{month:'YYYY-MM', value}].
function fill12(s) {
  const map = Object.fromEntries(s.map((r) => [r.month, r.value]));
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 11);
  for (let i = 0; i < 12; i++) {
    const m = d.toISOString().slice(0, 7);
    out.push({ month: m, value: map[m] != null ? map[m] : 0 });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

function notConfigured() {
  const note = 'Supabase not configured (set SUPABASE_DB_URL).';
  const p = (unit, src) => pending(unit, { source: src, note });
  const s = (src) => section([], { source: src, status: 'pending', note });
  return {
    asOf: new Date().toISOString(),
    kpis: {
      totalIncome: p('currency', SRC_INCOME),
      bureau: p('count', SRC_AC),
      tailor: p('count', SRC_AC),
      speakingEnquiries: p('count', SRC_AC_TODO),
    },
    incomeTrend: s(SRC_INCOME),
    enquiryTrend: s(SRC_AC),
    splitBreakdown: s(SRC_AC_TODO),
    inboundOutbound: s(SRC_AC_TODO),
    sales: {
      totalIncome: p('currency', SRC_INCOME),
      conferenceIncome: p('currency', SRC_INCOME),
      magExperiences: p('currency', SRC_INCOME),
    },
    conference: {
      kpis: {
        dealsWon: p('count', SRC_AC),
        winRate: p('percent', SRC_AC),
        avgDealValue: p('currency', SRC_AC),
        demosBooked: p('count', SRC_AC),
      },
      dealsWonTrend: s(SRC_AC),
      winRateTrend: s(SRC_AC),
      wonRevenueTrend: s(SRC_AC),
      demosTrend: s(SRC_AC),
      directIndirectShare: s(SRC_AC_TODO),
      directIndirectLeads: s(SRC_AC_TODO),
    },
  };
}
