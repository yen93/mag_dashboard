// Marketing — Social audience summary (Social Platforms KPI cards).
//
// Total followers across all four social accounts + the net-follower change, from the weekly
// Apify cache public.social_platform_stats (follower snapshots for Facebook, Instagram, James's
// LinkedIn and MAG's LinkedIn). Backs the "Total audience" + "Net new followers" KPI cards on
// social_platforms.html (the one place that needs follower HISTORY — /platforms only returns the
// latest snapshot). Plain SELECT, cached by the route.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC =
  'Live (Supabase): public.social_platform_stats — total followers across Facebook, Instagram and ' +
  'both LinkedIn accounts (latest weekly snapshot) + the net-follower change since a prior snapshot ' +
  '~28 days earlier (or the oldest snapshot when there is less history).';

const SQL = `
  with snaps as (
    select snapshot_date, sum(followers) as total
    from public.social_platform_stats
    group by snapshot_date
  ),
  latest as (select total, snapshot_date from snaps order by snapshot_date desc limit 1),
  prior as (
    select total, snapshot_date from snaps
    where snapshot_date <= (select snapshot_date from latest) - interval '28 days'
    order by snapshot_date desc limit 1
  ),
  oldest as (select total, snapshot_date from snaps order by snapshot_date asc limit 1)
  select
    (select total from latest)::int                                                   as total_followers,
    to_char((select snapshot_date from latest), 'YYYY-MM-DD')                         as latest_date,
    coalesce((select total from prior), (select total from oldest))::int              as prior_total,
    to_char(coalesce((select snapshot_date from prior), (select snapshot_date from oldest)), 'YYYY-MM-DD') as since_date`;

export async function getSocialAudience() {
  if (!supabaseConfigured()) {
    return { totalFollowers: null, netNew: null, sinceDate: null, meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' } };
  }
  const rows = await q(SQL);
  const r = rows[0] || {};
  const total = r.total_followers == null ? null : Number(r.total_followers);
  const prior = r.prior_total == null ? null : Number(r.prior_total);
  const netNew = total != null && prior != null ? total - prior : null;
  const live = total != null;
  return {
    totalFollowers: total,
    netNew,
    sinceDate: r.since_date || null,
    latestDate: r.latest_date || null,
    meta: {
      status: live ? 'live' : 'pending',
      source: SRC,
      note: live ? `Total ${total} followers; net ${netNew >= 0 ? '+' : ''}${netNew} since ${r.since_date}.` : 'No snapshots yet.',
    },
  };
}
