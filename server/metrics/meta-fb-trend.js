// Marketing — Facebook monthly net-follower-growth trend (Social Platforms tab).
//
// Backs the "Facebook — net follower growth" chart (follows vs unfollows by month). Reads the
// monthly cache public.meta_fb_monthly and, on each call, refreshes the most recent 2 months
// from the Meta Graph API (sum of page_daily_follows_unique / page_daily_unfollows_unique over
// each full calendar month — follows/unfollows are discrete events, so summing daily is the
// correct monthly total, and the daily time-series has no 30-day range cap) and upserts them,
// so the current month stays current and new months appear automatically. Older history is the
// one-time backfill. Server-side only (META_PAGE_TOKEN); returns whatever is cached if Graph is
// unreachable.
//
// FACEBOOK ONLY — Instagram exposes no unfollows metric at all, and its follower_count metric
// only covers the last 30 days, so a monthly follows/unfollows trend can't come from IG.

import { config, hasSource } from '../config.js';
import { q, supabaseConfigured } from '../providers/supabase.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const MONTHS_RETURNED = 13;
const REFRESH_MONTHS = 2;   // current + previous month, refreshed on each cache-miss

const SRC =
  'Live (Meta Graph API → public.meta_fb_monthly): Facebook monthly follows + unfollows ' +
  '(page_daily_follows_unique / page_daily_unfollows_unique summed per calendar month). ' +
  'Current + previous month refreshed on read; older months are the backfill. Facebook only — ' +
  'Instagram has no unfollows metric and follower_count is last-30-days only.';

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

// Sum of a daily Page metric over one full calendar month.
async function monthSum(pageId, token, metric, monthStart) {
  const y = monthStart.getUTCFullYear();
  const m = monthStart.getUTCMonth();
  const nextMonth = new Date(Date.UTC(y, m + 1, 1));
  const j = await graphGet(`/${pageId}/insights`, {
    metric,
    period: 'day',
    since: ymd(monthStart),
    until: ymd(nextMonth),
    access_token: token,
  });
  const values = (j.data && j.data[0] && j.data[0].values) || [];
  if (!values.length) return null;
  return values.reduce((s, v) => s + (Number(v.value) || 0), 0);
}

async function refreshRecentMonths(pageId, token) {
  const now = new Date();
  for (let i = REFRESH_MONTHS - 1; i >= 0; i--) {
    const ms = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    try {
      const follows = await monthSum(pageId, token, 'page_daily_follows_unique', ms);
      const unfollows = await monthSum(pageId, token, 'page_daily_unfollows_unique', ms);
      if (follows == null && unfollows == null) continue;
      await q(
        `insert into public.meta_fb_monthly (month_start, follows, unfollows)
         values ($1::date, $2, $3)
         on conflict (month_start) do update
           set follows = excluded.follows, unfollows = excluded.unfollows, captured_at = now()`,
        [ymd(ms), follows, unfollows],
      );
    } catch (err) {
      console.error('[meta-fb-trend] refresh', ymd(ms), 'failed:', err.message);
    }
  }
}

export async function getMetaFbTrend() {
  if (!supabaseConfigured()) {
    return { data: [], meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' } };
  }
  if (hasSource('meta')) {
    try {
      await refreshRecentMonths(config.meta.pageId, config.meta.pageToken);
    } catch (err) {
      console.error('[meta-fb-trend] refresh batch failed:', err.message);
    }
  }
  const rows = await q(
    `select to_char(month_start, 'YYYY-MM-DD') as month, follows, unfollows
       from public.meta_fb_monthly
      order by month_start desc
      limit $1`,
    [MONTHS_RETURNED],
  );
  const data = rows
    .map((r) => ({
      month: r.month,
      follows: r.follows == null ? null : Number(r.follows),
      unfollows: r.unfollows == null ? null : Number(r.unfollows),
    }))
    .reverse();   // ascending, oldest → newest, for the chart
  return {
    data,
    meta: {
      status: data.length ? 'live' : 'pending',
      source: SRC,
      note: data.length
        ? `${data.length} months of Facebook follows + unfollows.`
        : 'No data yet — the backfill has not run.',
    },
  };
}
