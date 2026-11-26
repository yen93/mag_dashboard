// Marketing — Social audience summary (Social Platforms KPI cards).
//
// Per-snapshot totals (followers, recent-post engagement, recent-post count) across all four social
// accounts, from the weekly Apify cache public.social_platform_stats. Backs the KPI cards on
// social_platforms.html — the one place that needs snapshot HISTORY (/platforms only returns the
// latest snapshot). Returns three snapshots: `latest`, `prior` (the newest snapshot at least ~28 days
// older, else the oldest snapshot) and `prior2` (the same rule applied again from `prior`, used to
// compare net-new-followers period against period). Plain SELECT, cached by the route.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC =
  'Live (Supabase): public.social_platform_stats — totals across Facebook, Instagram and both ' +
  'LinkedIn accounts for the latest weekly snapshot, compared with the snapshot ~28 days earlier ' +
  '(or the oldest snapshot when there is less history).';

const SQL = `
  select to_char(snapshot_date, 'YYYY-MM-DD') as d,
         sum(followers)::int        as followers,
         sum(total_engagement)::int as engagement,
         sum(posts)::int            as posts
  from public.social_platform_stats
  group by snapshot_date
  order by snapshot_date asc`;

const SQL_BY_PLATFORM = `
  select platform_key,
         to_char(snapshot_date, 'YYYY-MM-DD') as d,
         followers::int             as followers,
         total_engagement::int      as engagement,
         posts::int                 as posts,
         engagement_rate::float8    as engagement_rate
  from public.social_platform_stats
  order by platform_key asc, snapshot_date asc`;

const DAY = 86400000;
const t = (d) => Date.parse(d + 'T00:00:00Z');

// Newest snapshot strictly older than `from` by >= 28 days; else the oldest snapshot older than `from`.
function pickPrior(snaps, from) {
  if (!from) return null;
  const older = snaps.filter((s) => t(s.d) < t(from.d));
  if (!older.length) return null;
  const far = older.filter((s) => t(s.d) <= t(from.d) - 28 * DAY);
  return far.length ? far[far.length - 1] : older[0];
}

export async function getSocialAudience() {
  if (!supabaseConfigured()) {
    return { latest: null, prior: null, prior2: null, totalFollowers: null, netNew: null, sinceDate: null,
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' } };
  }
  const snaps = (await q(SQL)).map((r) => ({
    d: r.d,
    followers: r.followers == null ? null : Number(r.followers),
    engagement: r.engagement == null ? null : Number(r.engagement),
    posts: r.posts == null ? null : Number(r.posts),
  }));
  const platRows = await q(SQL_BY_PLATFORM);
  const byPlatform = {};
  for (const r of platRows) {
    if (!byPlatform[r.platform_key]) byPlatform[r.platform_key] = { snaps: [] };
    byPlatform[r.platform_key].snaps.push({
      d: r.d,
      followers: r.followers == null ? null : Number(r.followers),
      engagement: r.engagement == null ? null : Number(r.engagement),
      posts: r.posts == null ? null : Number(r.posts),
      engagementRate: r.engagement_rate == null ? null : Number(r.engagement_rate),
    });
  }
  for (const key of Object.keys(byPlatform)) {
    const list = byPlatform[key].snaps;
    const pLatest = list.length ? list[list.length - 1] : null;
    const pPrior = pickPrior(list, pLatest);
    const pNetNew = pLatest && pPrior && pLatest.followers != null && pPrior.followers != null
      ? pLatest.followers - pPrior.followers
      : null;
    const pRate = pNetNew != null && pPrior && pPrior.followers > 0
      ? Math.round((pNetNew / pPrior.followers) * 1000) / 10
      : null;
    byPlatform[key] = { latest: pLatest, prior: pPrior, netNew: pNetNew, netNewRate: pRate, snaps: list };
  }
  const latest = snaps.length ? snaps[snaps.length - 1] : null;
  const prior = pickPrior(snaps, latest);
  const prior2 = pickPrior(snaps, prior);
  const netNew = latest && prior ? latest.followers - prior.followers : null;
  const live = !!latest;
  return {
    latest, prior, prior2,
    snaps,   // every snapshot (small), so the client can pick a year-ago comparison when one exists
    byPlatform,
    // back-compat fields
    totalFollowers: latest ? latest.followers : null,
    netNew,
    sinceDate: prior ? prior.d : null,
    latestDate: latest ? latest.d : null,
    meta: {
      status: live ? 'live' : 'pending',
      source: SRC,
      note: live ? `Total ${latest.followers} followers; net ${netNew == null ? 'n/a' : (netNew >= 0 ? '+' : '') + netNew}${prior ? ' since ' + prior.d : ''}.` : 'No snapshots yet.',
    },
  };
}
