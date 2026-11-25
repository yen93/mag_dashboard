// Marketing — Facebook LIVE insights (Social Platforms tab).
//
// Pulls REAL Facebook Page metrics at request time from the Meta Graph API using a
// non-expiring Page access token (a Page token derived from a long-lived user token).
// Server-side ONLY — the token is a Cloud Run secret (META_PAGE_TOKEN) and is never sent
// to the browser (same pattern as OPENAI_API_KEY / GEMINI_API_KEY). The route caches the
// result ~10 min so page views don't hammer Graph.
//
// Scope (what's actually available, verified against the live API 2026-11-25):
//   - Followers (followers_count), 28-day page views (page_views_total), 28-day new
//     follows (page_daily_follows_unique), 28-day post engagements (page_post_engagements).
//   - FACEBOOK ONLY. Instagram needs a Business/Creator account linked to the Page +
//     instagram_basic / instagram_manage_insights scopes (not granted yet) — so IG stays
//     sample on the page.
//   - REACH / IMPRESSIONS are deprecated by Meta's Page Insights API (every reach metric
//     name is now rejected), so the page leaves its reach tiles as sample/pending.
//
// Degrades gracefully: any sub-call that fails leaves its field null; if nothing comes
// back (token missing/expired) the whole payload is {facebook:null|zeros, status:pending}
// and the page keeps its sample figures rather than breaking.

import { config, hasSource } from '../config.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

const SRC =
  'Live (Meta Graph API): Facebook Page Insights for the MAG Page, fetched at request ' +
  'time with a non-expiring Page token. Followers = followers_count; 28-day views / new ' +
  'follows / post engagements from Page Insights. Reach & impressions are deprecated by ' +
  'Meta and not available via the API.';

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

  const live = fb.followers != null || fb.views28d != null || fb.postEngagements28d != null;
  return {
    facebook: live ? fb : null,
    meta: {
      status: live ? 'live' : 'pending',
      source: SRC,
      note: live
        ? `Facebook live as of ${fb.asOf}.`
        : 'Meta Graph API returned no Facebook data — the Page token may be invalid or revoked.',
    },
  };
}
