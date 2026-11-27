// Marketing — Meta (Facebook + Instagram) LIVE insights (Social Platforms tab).
//
// Pulls REAL Facebook Page + linked Instagram Business account metrics at request time
// from the Meta Graph API using a non-expiring Page access token (a Page token derived
// from a long-lived user token, with the instagram_basic / instagram_manage_insights
// scopes). Server-side ONLY — the token is a Cloud Run secret (META_PAGE_TOKEN) and is
// never sent to the browser (same pattern as OPENAI_API_KEY / GEMINI_API_KEY). The route
// caches the result ~10 min so page views don't hammer Graph.
//
// Scope (verified against the live API 2026-11-25):
//   FACEBOOK Page: followers (followers_count), 28-day page views (page_views_total),
//     28-day new follows (page_daily_follows_unique), 28-day post engagements
//     (page_post_engagements). NB Facebook page REACH / IMPRESSIONS are deprecated (every
//     reach metric name is rejected) — only views are available.
//   INSTAGRAM Business account (linked to the Page): followers_count, media_count, 28-day
//     REACH (the real reach figure Facebook can't give), and recent-media engagement
//     (sum of like_count + comments_count over the latest posts). The IG user id is
//     discovered at request time via the Page's instagram_business_account edge — no extra
//     config. IG account-level engagement metrics only support period=day (not days_28),
//     so a comparable window uses recent media instead.
//     Additional IG account metrics over a trailing 28-day window (metric_type=total_value,
//     period=day, since/until — all verified live 2026-11-27): views (6.8k), profile_views
//     (= profile VISITS), website_clicks + profile_links_taps (= LINK CLICKS), reach split
//     by follow_type (FOLLOWER vs NON_FOLLOWER → the non-follower reach %), and follower_count
//     (a daily NET series, summed → NET new follows). NB gross UNFOLLOWS are NOT exposed:
//     follows_and_unfollows only breaks down by follow_type (actor relationship), whose
//     FOLLOWER value equals the net follower_count — so only NET follows are reportable.
//
// Degrades gracefully: any sub-call that fails leaves its field null; a platform with no
// data comes back null and the page keeps that platform's sample figures rather than
// breaking.

import { config, hasSource } from '../config.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const IG_MEDIA_LIMIT = 24;   // recent posts summed for the IG engagement figure — 24 to match the
                             // Apify LinkedIn scrape's MAX_POSTS=24, so the Engagement chart's IG bar
                             // (Meta API, likes+comments) and LinkedIn bars (Apify) use the same 24-post window

const SRC =
  'Live (Meta Graph API): Facebook Page Insights + the linked Instagram Business account, ' +
  'fetched at request time with a non-expiring Page token. FB: followers, 28-day views / ' +
  'new follows / post engagements (FB reach/impressions are deprecated by Meta). IG (28-day ' +
  'window): followers, reach, post count, recent-media engagement (likes + comments), views, ' +
  'profile visits, link clicks, non-follower reach %, and net new follows.';

const ymd = (d) => d.toISOString().slice(0, 10);

async function graphGet(path, params) {
  const url = new URL(GRAPH + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error ? j.error.message : `HTTP ${r.status}`);
  return j;
}

export async function getMetaFbInsights() {
  if (!hasSource('meta')) {
    return { facebook: null, meta: { status: 'pending', source: SRC, note: 'META_PAGE_TOKEN not set — Facebook figures stay sample.' } };
  }
  const token = config.meta.pageToken;
  const pageId = config.meta.pageId;
  const fb = {
    pageName: null,
    followers: null,
    views28d: null,          // back-compat (page_views_total)
    mediaViews28d: null,     // page_media_view (content views across posts/reels)
    pageVisits28d: null,     // page_views_total (Page visits)
    viewers28d: null,        // unique viewers if exposed by Meta (retired on New Pages → stays null)
    videoViews28d: null,     // page_video_views (28-day total video views)
    linkClicks28d: null,     // link clicks / total actions if exposed by Meta
    newFollows28d: null,
    postEngagements28d: null,
    asOf: new Date().toISOString().slice(0, 10),
  };

  // Profile (followers). Isolated so an insights outage doesn't drop the follower count.
  try {
    const prof = await graphGet(`/${pageId}`, { fields: 'name,followers_count,fan_count', access_token: token });
    fb.pageName = prof.name || null;
    if (prof.followers_count != null) fb.followers = Number(prof.followers_count);
    else if (prof.fan_count != null) fb.followers = Number(prof.fan_count);
  } catch (err) {
    console.error('[meta-fb] profile fetch failed:', err.message);
  }

  // Core 28-day Page Insights (proven working on this Page token).
  try {
    const ins = await graphGet(`/${pageId}/insights`, {
      metric: 'page_views_total,page_daily_follows_unique,page_post_engagements',
      period: 'days_28',
      access_token: token,
    });
    const latest = {};
    (ins.data || []).forEach((m) => {
      const vs = m.values || [];
      latest[m.name] = vs.length ? Number(vs[vs.length - 1].value) : null;
    });
    if (latest.page_views_total != null) {
      fb.views28d = latest.page_views_total;
      fb.pageVisits28d = latest.page_views_total;
    }
    if (latest.page_daily_follows_unique != null) fb.newFollows28d = latest.page_daily_follows_unique;
    if (latest.page_post_engagements != null) fb.postEngagements28d = latest.page_post_engagements;
  } catch (err) {
    console.error('[meta-fb] insights fetch failed:', err.message);
  }

  // Additional 28-day Facebook Page Insights (each isolated so Meta deprecations never fail the core call).
  async function tryFbMetric(metric) {
    try {
      const ins = await graphGet(`/${pageId}/insights`, { metric, period: 'days_28', access_token: token });
      const vs = (ins.data && ins.data[0] && ins.data[0].values) || [];
      return vs.length ? vs[vs.length - 1].value : null;
    } catch {
      return null;
    }
  }

  // Content views (Meta v21+ replacement for page_impressions)
  const mediaView = await tryFbMetric('page_media_view');
  if (mediaView != null && !Number.isNaN(Number(mediaView))) {
    fb.mediaViews28d = Number(mediaView);
  }

  // Link clicks / CTA actions (try consumptions breakdown, then page_total_actions)
  const cons = await tryFbMetric('page_consumptions_by_consumption_type');
  if (cons && typeof cons === 'object') {
    const lc = cons['link clicks'] ?? cons.link_clicks;
    if (lc != null && !Number.isNaN(Number(lc))) fb.linkClicks28d = Number(lc);
  }
  if (fb.linkClicks28d == null) {
    const acts = await tryFbMetric('page_total_actions');
    if (acts != null && !Number.isNaN(Number(acts))) fb.linkClicks28d = Number(acts);
  }

  // Unique viewers (try page_impressions_unique — null when deprecated)
  const uniqViewers = await tryFbMetric('page_impressions_unique');
  if (uniqViewers != null && !Number.isNaN(Number(uniqViewers))) {
    fb.viewers28d = Number(uniqViewers);
  }

  // Video views (page_video_views) — a real, live 28-day metric. Unique viewers / page reach are
  // retired on New Pages (every reach metric returns "(#100) not a valid insights metric", verified
  // 2026-11-27), so the "Viewers" card is fed by video views instead.
  const videoViews = await tryFbMetric('page_video_views');
  if (videoViews != null && !Number.isNaN(Number(videoViews))) {
    fb.videoViews28d = Number(videoViews);
  }

  const fbLive = fb.followers != null || fb.views28d != null || fb.mediaViews28d != null || fb.postEngagements28d != null;

  // ── Instagram (the Business account linked to the Page) ──────────────────────
  const ig = {
    username: null,
    followers: null,
    mediaCount: null,
    reach28d: null,
    recentEngagement: null,
    recentPosts: null,
    views28d: null,            // IG "views" metric (reels + posts + stories), 28-day total
    profileViews28d: null,     // profile_views = profile VISITS, 28-day total
    linkClicks28d: null,       // website_clicks + profile_links_taps, 28-day total
    netFollows28d: null,       // follower_count daily NET series, summed over 28 days
    reachFollower28d: null,    // 28-day reach from existing followers
    reachNonFollower28d: null, // 28-day reach from non-followers
    nonFollowerReachPct: null, // non-follower share of reach (%)
    asOf: fb.asOf,
  };
  let igId = null;
  try {
    const link = await graphGet(`/${pageId}`, {
      fields: 'instagram_business_account{id,username,followers_count,media_count}',
      access_token: token,
    });
    const iba = link.instagram_business_account;
    if (iba && iba.id) {
      igId = iba.id;
      ig.username = iba.username || null;
      if (iba.followers_count != null) ig.followers = Number(iba.followers_count);
      if (iba.media_count != null) ig.mediaCount = Number(iba.media_count);
    }
  } catch (err) {
    console.error('[meta-ig] link/profile fetch failed:', err.message);
  }
  if (igId) {
    // 28-day account reach — the real reach figure (FB's is deprecated).
    try {
      const ins = await graphGet(`/${igId}/insights`, { metric: 'reach', period: 'days_28', access_token: token });
      const vs = (ins.data && ins.data[0] && ins.data[0].values) || [];
      if (vs.length) ig.reach28d = Number(vs[vs.length - 1].value);
    } catch (err) {
      console.error('[meta-ig] reach fetch failed:', err.message);
    }
    // Recent-media engagement (likes + comments) — IG account engagement metrics only
    // support period=day, so we sum the latest posts for a comparable figure.
    try {
      const media = await graphGet(`/${igId}/media`, {
        fields: 'like_count,comments_count',
        limit: String(IG_MEDIA_LIMIT),
        access_token: token,
      });
      const arr = media.data || [];
      if (arr.length) {
        ig.recentPosts = arr.length;
        ig.recentEngagement = arr.reduce(
          (s, m) => s + (Number(m.like_count) || 0) + (Number(m.comments_count) || 0), 0);
      }
    } catch (err) {
      console.error('[meta-ig] media fetch failed:', err.message);
    }

    // Additional IG account metrics over a trailing 28-day window (metric_type=total_value,
    // period=day, since/until — the Graph API caps the span at 30 days). Each isolated so a
    // single deprecation never drops the rest.
    const until = new Date();
    const since = new Date(until.getTime() - 28 * 86400000);
    const sinceS = ymd(since);
    const untilS = ymd(until);

    async function igTotal(metric, breakdown) {
      try {
        const params = { metric, metric_type: 'total_value', period: 'day', since: sinceS, until: untilS, access_token: token };
        if (breakdown) params.breakdown = breakdown;
        const j = await graphGet(`/${igId}/insights`, params);
        return (j.data && j.data[0] && j.data[0].total_value) || null;
      } catch {
        return null;
      }
    }

    const [viewsTV, visitsTV, webTV, linkTapsTV, reachBdTV] = await Promise.all([
      igTotal('views'),
      igTotal('profile_views'),
      igTotal('website_clicks'),
      igTotal('profile_links_taps'),
      igTotal('reach', 'follow_type'),
    ]);

    if (viewsTV && viewsTV.value != null) ig.views28d = Number(viewsTV.value);
    if (visitsTV && visitsTV.value != null) ig.profileViews28d = Number(visitsTV.value);

    const web = webTV && webTV.value != null ? Number(webTV.value) : null;
    const taps = linkTapsTV && linkTapsTV.value != null ? Number(linkTapsTV.value) : null;
    if (web != null || taps != null) ig.linkClicks28d = (web || 0) + (taps || 0);

    const reachRes = reachBdTV && reachBdTV.breakdowns && reachBdTV.breakdowns[0] && reachBdTV.breakdowns[0].results;
    if (reachRes && reachRes.length) {
      let f = null;
      let nf = null;
      for (const r of reachRes) {
        const key = (r.dimension_values && r.dimension_values[0]) || '';
        if (key === 'FOLLOWER') f = Number(r.value) || 0;
        else if (key === 'NON_FOLLOWER') nf = Number(r.value) || 0;
      }
      if (f != null) ig.reachFollower28d = f;
      if (nf != null) ig.reachNonFollower28d = nf;
      const tot = (f || 0) + (nf || 0);
      if (tot > 0 && nf != null) ig.nonFollowerReachPct = Math.round((nf / tot) * 1000) / 10;
    }

    // Net new follows over the window (follower_count is a daily NET series; it rejects
    // metric_type=total_value, so sum the daily values ourselves).
    try {
      const j = await graphGet(`/${igId}/insights`, { metric: 'follower_count', period: 'day', since: sinceS, until: untilS, access_token: token });
      const vals = (j.data && j.data[0] && j.data[0].values) || [];
      if (vals.length) ig.netFollows28d = vals.reduce((s, v) => s + (Number(v.value) || 0), 0);
    } catch (err) {
      console.error('[meta-ig] follower_count fetch failed:', err.message);
    }
  }
  const igLive = ig.followers != null || ig.reach28d != null;

  return {
    facebook: fbLive ? fb : null,
    instagram: igLive ? ig : null,
    meta: {
      status: fbLive || igLive ? 'live' : 'pending',
      source: SRC,
      note: fbLive || igLive
        ? `Meta live as of ${fb.asOf} (Facebook: ${fbLive ? 'yes' : 'no'}, Instagram: ${igLive ? 'yes' : 'no'}).`
        : 'Meta Graph API returned no data — the Page token may be invalid or revoked.',
    },
  };
}
