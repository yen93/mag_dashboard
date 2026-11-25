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
//
// Degrades gracefully: any sub-call that fails leaves its field null; a platform with no
// data comes back null and the page keeps that platform's sample figures rather than
// breaking.

import { config, hasSource } from '../config.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const IG_MEDIA_LIMIT = 25;   // recent posts summed for the IG engagement figure

const SRC =
  'Live (Meta Graph API): Facebook Page Insights + the linked Instagram Business account, ' +
  'fetched at request time with a non-expiring Page token. FB: followers, 28-day views / ' +
  'new follows / post engagements (FB reach/impressions are deprecated by Meta). IG: ' +
  'followers, 28-day reach, post count, and recent-media engagement (likes + comments).';

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
    views28d: null,
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

  // 28-day Page Insights (views / new follows / post engagements).
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
    if (latest.page_views_total != null) fb.views28d = latest.page_views_total;
    if (latest.page_daily_follows_unique != null) fb.newFollows28d = latest.page_daily_follows_unique;
    if (latest.page_post_engagements != null) fb.postEngagements28d = latest.page_post_engagements;
  } catch (err) {
    console.error('[meta-fb] insights fetch failed:', err.message);
  }

  const fbLive = fb.followers != null || fb.views28d != null || fb.postEngagements28d != null;

  // ── Instagram (the Business account linked to the Page) ──────────────────────
  const ig = {
    username: null,
    followers: null,
    mediaCount: null,
    reach28d: null,
    recentEngagement: null,
    recentPosts: null,
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
