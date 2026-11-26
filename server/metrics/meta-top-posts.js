// Marketing — Top posts (Social Platforms tab).
//
// Recent Instagram posts ranked by ENGAGEMENT (likes + comments), fetched at request time from
// the Meta Graph API (cached ~10 min by the route; no cache table — it's a live "recent posts"
// list). Each row carries REAL per-post reach (/{media}/insights?metric=reach). Server-side only
// (META_PAGE_TOKEN).
//
// INSTAGRAM ONLY, by two hard limits proven against the live API (2026-11-25):
//   - Facebook: the per-post like/comment COUNTS (likes.summary / comments.summary) return
//     error #10 "requires Page Public Content Access" — an app-review feature this app lacks — so
//     FB can't yield a real engagement number (only shares, ~0 on this low-activity page). FB post
//     reach is also deprecated. So FB adds nothing and is excluded.
//   - LinkedIn: post data only comes through the weekly apify-platforms-sync edge fn (the dashboard
//     server has no Apify access). Including James's / MAG's LinkedIn posts means extending that
//     sync to store individual posts in a table; out of scope for this request-time endpoint.

import { config, hasSource } from '../config.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const FETCH_LIMIT = 25;   // recent posts pulled before ranking
const TOP_N = 8;          // rows shown

const SRC =
  'Live (Meta Graph API): recent Instagram posts ranked by engagement (likes + comments), each ' +
  'with its real per-post reach. Instagram only — Facebook per-post like/comment counts need ' +
  'Page Public Content Access (app review) and FB post reach is deprecated; LinkedIn posts come ' +
  'from the Apify sync, not this endpoint.';

async function graphGet(path, params) {
  const url = new URL(GRAPH + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error ? j.error.message : `HTTP ${r.status}`);
  return j;
}

function clip(s, n = 90) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
const ymd = (iso) => (iso ? String(iso).slice(0, 10) : '');

function mediaLabel(t) {
  if (!t) return null;
  const u = String(t).toUpperCase();
  if (u === 'VIDEO' || u === 'REELS') return 'Reel / Video';
  if (u === 'CAROUSEL_ALBUM') return 'Carousel';
  if (u === 'IMAGE') return 'Image';
  return t;
}

export async function getMetaTopPosts() {
  if (!hasSource('meta')) {
    return { data: [], meta: { status: 'pending', source: SRC, note: 'META_PAGE_TOKEN not set.' } };
  }
  const token = config.meta.pageToken;
  const igId = config.meta.igId;
  let posts = [];

  // Instagram media (engagement = likes + comments).
  try {
    const j = await graphGet(`/${igId}/media`, {
      fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count',
      limit: String(FETCH_LIMIT),
      access_token: token,
    });
    posts = (j.data || []).map((m) => ({
      mediaId: m.id,
      platform: 'Instagram',
      type: mediaLabel(m.media_type),
      post: clip(m.caption) || `(${(m.media_type || 'post').toLowerCase()})`,
      date: ymd(m.timestamp),
      url: m.permalink || null,
      interactions: (Number(m.like_count) || 0) + (Number(m.comments_count) || 0),
      reach: null,
    }));
  } catch (err) {
    console.error('[meta-top-posts] IG media failed:', err.message);
  }

  // Rank by engagement, take the top N.
  posts.sort((a, b) => b.interactions - a.interactions);
  const top = posts.slice(0, TOP_N);

  // Enrich each with its real per-post reach (bounded: <= TOP_N calls).
  for (const p of top) {
    if (p.mediaId) {
      try {
        const j = await graphGet(`/${p.mediaId}/insights`, { metric: 'reach', access_token: token });
        const v = j.data && j.data[0] && j.data[0].values && j.data[0].values[0];
        if (v && v.value != null) p.reach = Number(v.value);
      } catch (err) {
        /* reach unavailable for some media types — leave null */
      }
    }
  }

  const data = top.map((p) => ({
    post: p.post,
    platform: p.platform,
    type: p.type,
    date: p.date,
    url: p.url,
    reach: p.reach,
    interactions: p.interactions,
  }));
  return {
    data,
    meta: {
      status: data.length ? 'live' : 'pending',
      source: SRC,
      note: data.length ? `Top ${data.length} Instagram posts by engagement.` : 'No posts returned by Meta.',
    },
  };
}
