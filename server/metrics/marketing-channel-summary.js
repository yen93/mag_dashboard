// Marketing Channel Summary — FY marketing spend BY MONTH, stacked by Type category
// or by ad Platform. LIVE from Xero via public.marketing_channel_monthly (filled monthly
// by the xero-channel-summary-sync edge function), categorised through
// public.marketing_channel_vendor_map by contact_id. Replaces the static FY25-26 load
// that was hard-coded in roi.html from the "MAG: MKTG ROI Report" workbook.
//
// Shape returned matches what roi.html's renderChannelChart() expects:
//   { months:['Jul-2025',…], type:[{name,data:[…]}], platform:[{name,data:[…]}], meta }
// `type` covers ALL kept spend (unmapped vendors on the open accounts 302/475 roll up as
// 'Uncategorized'); `platform` covers only the ad platforms (Google/Bing/Website/…).

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'Live (Supabase): marketing_channel_monthly (Xero bank txns, acct 302/475/332/411/377) × marketing_channel_vendor_map';

// month 'YYYY-MM-01' → 'Mon-YYYY' (e.g. 2025-07-01 → Jul-2025).
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monLabel(d) {
  const s = String(d).slice(0, 10);
  const [y, m] = s.split('-').map(Number);
  return `${MON[m - 1]}-${y}`;
}

const BY_TYPE = `
  SELECT to_char(c.month, 'YYYY-MM-01') AS month,
         coalesce(m.type, 'Uncategorized') AS bucket,
         round(sum(c.amount))::numeric AS amount
  FROM public.marketing_channel_monthly c
  LEFT JOIN public.marketing_channel_vendor_map m ON m.contact_id = c.contact_id
  GROUP BY 1, 2`;

const BY_PLATFORM = `
  SELECT to_char(c.month, 'YYYY-MM-01') AS month,
         m.platform AS bucket,
         round(sum(c.amount))::numeric AS amount
  FROM public.marketing_channel_monthly c
  JOIN public.marketing_channel_vendor_map m ON m.contact_id = c.contact_id
  WHERE m.platform IS NOT NULL
  GROUP BY 1, 2`;

// Pivot [{month, bucket, amount}] → { months:[…], series:[{name,data:[…]}] }.
// Series ordered by grand total desc; 'Uncategorized' always sorts last.
function pivot(rows) {
  const monthsSet = new Set();
  const buckets = new Map(); // name -> Map(month -> amount)
  for (const r of rows) {
    monthsSet.add(r.month);
    if (!buckets.has(r.bucket)) buckets.set(r.bucket, new Map());
    buckets.get(r.bucket).set(r.month, Number(r.amount) || 0);
  }
  const months = [...monthsSet].sort();
  const totals = (name) => [...buckets.get(name).values()].reduce((a, v) => a + v, 0);
  const names = [...buckets.keys()].sort((a, b) => {
    if (a === 'Uncategorized') return 1;
    if (b === 'Uncategorized') return -1;
    return totals(b) - totals(a);
  });
  const series = names.map((name) => ({
    name,
    data: months.map((mo) => buckets.get(name).get(mo) || 0),
  }));
  return { months, series };
}

export async function getMarketingChannelSummary() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      months: [],
      type: section([], { source: SRC, status: 'pending', note: 'Supabase not configured.' }).data,
      platform: [],
      meta: { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' },
    };
  }

  const [typeRows, platRows] = await Promise.all([q(BY_TYPE), q(BY_PLATFORM)]);
  const t = pivot(typeRows);
  const p = pivot(platRows);

  // Both breakdowns share the same month axis (the union of months seen).
  const months = [...new Set([...t.months, ...p.months])].sort();
  const reindex = (series, srcMonths) => series.map((s) => {
    const byMonth = new Map(srcMonths.map((mo, i) => [mo, s.data[i]]));
    return { name: s.name, data: months.map((mo) => byMonth.get(mo) || 0) };
  });

  const note = months.length
    ? `${months.length} month(s) (${monLabel(months[0])}–${monLabel(months[months.length - 1])}). ` +
      `Live Xero marketing spend (bank transactions on accounts 302/475/332/411/377), categorised by ` +
      `vendor. Refreshed monthly by xero-channel-summary-sync. Unmapped vendors on the ad accounts ` +
      `(302/475) show as "Uncategorized".`
    : 'No channel-summary rows yet — run the xero-channel-summary-sync edge function.';

  return {
    asOf: new Date().toISOString(),
    months: months.map(monLabel),
    type: reindex(t.series, t.months),
    platform: reindex(p.series, p.months),
    meta: { source: SRC, status: months.length ? 'live' : 'pending', note },
  };
}
