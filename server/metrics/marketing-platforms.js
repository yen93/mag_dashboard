// Marketing — Platforms (Content & Social tab).
//
// Backs the "Platforms" table + per-platform follower cards on
// public/content_social.html. Plain SELECT of public.social_platform_stats — the
// cache of weekly PUBLIC social-stat snapshots filled by the apify-platforms-sync
// edge function (upsert-only, never truncates).
//
// Returns the LATEST snapshot per platform FOR EACH Australian financial year
// (END-year, Jul–Jun), so the page's FY toggle can switch the values. Social scrapes
// only capture the current state, so FYs before data collection started are simply
// absent; the client shows the newest snapshot within the selected FY (or, for
// "All years", the newest overall per platform). Impressions / reach are private
// platform analytics and are deliberately not scraped or shown.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC =
  'Live (Supabase): social_platform_stats — public follower / post / engagement ' +
  'stats scraped weekly via Apify (apify-platforms-sync). Latest snapshot per ' +
  'platform per financial year. Impressions / reach are private platform analytics ' +
  'and are not scraped.';

// Latest snapshot per (platform, AU financial-year END-year). fy_end = calendar year
// of the snapshot + 1 when month >= July.
const SQL = `
  WITH s AS (
    SELECT *,
      (extract(year FROM snapshot_date)::int
        + CASE WHEN extract(month FROM snapshot_date) >= 7 THEN 1 ELSE 0 END) AS fy_end
    FROM public.social_platform_stats
  ),
  per_fy AS (
    SELECT *, row_number() OVER (PARTITION BY platform_key, fy_end ORDER BY snapshot_date DESC) AS rn
    FROM s
  )
  SELECT platform_key, platform_name, network, profile_url, fy_end,
         to_char(snapshot_date, 'YYYY-MM-DD')     AS snapshot_date,
         followers::int                           AS followers,
         posts::int                               AS posts,
         total_engagement::int                    AS total_engagement,
         avg_engagement_per_post::float8          AS avg_engagement_per_post,
         engagement_rate::float8                  AS engagement_rate
  FROM per_fy
  WHERE rn = 1
  ORDER BY fy_end DESC, followers DESC NULLS LAST`;

export async function getMarketingPlatforms() {
  if (!supabaseConfigured()) {
    return { data: [], meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' } };
  }
  const n = (v) => (v == null ? null : Number(v));
  const rows = await q(SQL);
  const data = rows.map((r) => ({
    platformKey: r.platform_key,
    platformName: r.platform_name,
    network: r.network,
    profileUrl: r.profile_url,
    fyEnd: n(r.fy_end),
    snapshotDate: r.snapshot_date,
    followers: n(r.followers),
    posts: n(r.posts),
    totalEngagement: n(r.total_engagement),
    avgEngagementPerPost: n(r.avg_engagement_per_post),
    engagementRate: n(r.engagement_rate),
  }));
  const status = data.length ? 'live' : 'pending';
  const note = data.length
    ? `${data.length} platform-FY rows.`
    : 'No snapshots yet — the weekly Apify sync has not run.';
  return { data, meta: { status, source: SRC, note } };
}
