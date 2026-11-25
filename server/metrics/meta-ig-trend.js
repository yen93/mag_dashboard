// Marketing — Instagram monthly reach + content-interactions trend (Social Platforms tab).
//
// Backs the "Instagram — reach & content interactions · trend" chart. Reads the monthly
// cache public.meta_ig_monthly and, on each call, refreshes the most recent 2 months from
// the Meta Graph API (metric_type=total_value over each calendar month, 30-day-capped
// since/until → the TRUE de-duplicated monthly reach, not a sum of daily values) and upserts
// them, so the current month stays current and a new month appears on its own. Older history
// is the one-time backfill. Server-side only (META_PAGE_TOKEN); if Graph is unreachable it
// just returns whatever is already cached.
//
// INSTAGRAM ONLY — Facebook page reach is deprecated by Meta's API (verified across page +
// post level and 6 API versions), so this trend can only come from Instagram.

import { config, hasSource } from '../config.js';
import { q, supabaseConfigured } from '../providers/supabase.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const MONTHS_RETURNED = 13;
const REFRESH_MONTHS = 2;   // current + previous month, refreshed on each cache-miss

const SRC =
  'Live (Meta Graph API → public.meta_ig_monthly): Instagram monthly reach + content ' +
  'interactions (total_value per calendar month, 30-day-capped). Current + previous month ' +
  'refreshed on read; older months are the backfill. Instagram only — Facebook page reach ' +
  'is deprecated by Meta.';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

async function graphGet(path, params) {
  const url = new URL(GRAPH + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error ? j.error.message : `HTTP ${r.status}`);
  return j;
}

// total_value of an IG account metric over one calendar month (window capped at 30 days,
// since the Graph API rejects since→until spans over 30 days; 31-day months drop their last day).
async function monthMetric(igId, token, metric, monthStart) {
  const y = monthStart.getUTCFullYear();
  const m = monthStart.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const until = new Date(Date.UTC(y, m, 1 + Math.min(daysInMonth, 30)));
  const j = await graphGet(`/${igId}/insights`, {
    metric,
    metric_type: 'total_value',
    period: 'day',
    since: ymd(monthStart),
    until: ymd(until),
    access_token: token,
  });
  const tv = j.data && j.data[0] && j.data[0].total_value;
  return tv && tv.value != null ? Number(tv.value) : null;
}

async function refreshRecentMonths(igId, token) {
  const now = new Date();
  for (let i = REFRESH_MONTHS - 1; i >= 0; i--) {
    const ms = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    try {
      const reach = await monthMetric(igId, token, 'reach', ms);
      const interactions = await monthMetric(igId, token, 'total_interactions', ms);
      if (reach == null && interactions == null) continue;
      await q(
        `insert into public.meta_ig_monthly (month_start, reach, interactions)
         values ($1::date, $2, $3)
         on conflict (month_start) do update
           set reach = excluded.reach, interactions = excluded.interactions, captured_at = now()`,
        [ymd(ms), reach, interactions],
      );
    } catch (err) {
      console.error('[meta-ig-trend] refresh', ymd(ms), 'failed:', err.message);
    }
  }
}

export async function getMetaIgTrend() {
  if (!supabaseConfigured()) {
    return { data: [], meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' } };
  }
  // Best-effort refresh of the current + previous month — never blocks the read on failure.
  if (hasSource('meta')) {
    try {
      await refreshRecentMonths(config.meta.igId, config.meta.pageToken);
    } catch (err) {
      console.error('[meta-ig-trend] refresh batch failed:', err.message);
    }
  }
  const rows = await q(
    `select to_char(month_start, 'YYYY-MM-DD') as month, reach, interactions
       from public.meta_ig_monthly
      order by month_start desc
      limit $1`,
    [MONTHS_RETURNED],
  );
  const data = rows
    .map((r) => ({
      month: r.month,
      reach: r.reach == null ? null : Number(r.reach),
      interactions: r.interactions == null ? null : Number(r.interactions),
    }))
    .reverse();   // ascending, oldest → newest, for the chart
  return {
    data,
    meta: {
      status: data.length ? 'live' : 'pending',
      source: SRC,
      note: data.length
        ? `${data.length} months of Instagram reach + interactions.`
        : 'No data yet — the backfill has not run.',
    },
  };
}
