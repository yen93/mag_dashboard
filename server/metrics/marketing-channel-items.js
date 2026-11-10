// Marketing Channel Items — the distinct VENDORS (line items) behind each "Spend by type"
// bucket, per month. Powers the drill-down modal on spend_roi.html: click a bar in the
// "Spend by type" chart → list the specific vendors under that type (names only, no $).
//
// Mirrors marketing-channel-summary.js's BY_TYPE bucketing EXACTLY (same LEFT JOIN +
// coalesce(type,'Uncategorized')) so the item list matches the bar it drills into. Each
// row carries a 'Mon-YYYY' month so the client can FY/range-filter it the same way the
// chart filters the bars.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC = 'Live (Supabase): marketing_channel_monthly × marketing_channel_vendor_map (Xero bank txns)';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monLabel(d) {
  const s = String(d).slice(0, 10);
  const [y, m] = s.split('-').map(Number);
  return `${MON[m - 1]}-${y}`;
}

// Distinct (type bucket, vendor, month). Grouped by vendor text so multiple contact_ids
// with the same display name collapse to one item. 'Uncategorized' = unmapped vendors.
const SQL = `
  SELECT coalesce(m.type, 'Uncategorized') AS type,
         c.vendor AS vendor,
         to_char(c.month, 'YYYY-MM-01') AS month
  FROM public.marketing_channel_monthly c
  LEFT JOIN public.marketing_channel_vendor_map m ON m.contact_id = c.contact_id
  WHERE c.vendor IS NOT NULL AND btrim(c.vendor) <> ''
  GROUP BY 1, 2, 3`;

export async function getMarketingChannelItems() {
  if (!supabaseConfigured()) {
    return { items: [], meta: { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' } };
  }
  const rows = await q(SQL);
  const items = rows.map((r) => ({ type: r.type, vendor: r.vendor, month: monLabel(r.month) }));
  return {
    items,
    meta: {
      source: SRC,
      status: items.length ? 'live' : 'pending',
      note: `${items.length} vendor-month item(s) across the marketing spend types.`,
    },
  };
}
