// Marketing — Instagram "What works best, by type" (Social Platforms tab).
//
// Average per-post REACH + engagement grouped by content format (Reel/Video, Carousel, Image)
// across recent Instagram posts. Backs the "What works best, by type — Instagram" card.
//
// Per-post reach is one Graph call PER post (~24), so unlike the other request-time Meta
// endpoints this one is CACHED to public.meta_ig_by_type and refreshed AT MOST ONCE A DAY: a
// read only triggers the ~24 Graph calls when the stored snapshot is older than REFRESH_AFTER
// hours; otherwise it just serves the cached rows. The Meta Graph API is free — the daily gate
// keeps the call volume + latency down. UPSERT-ONLY, never truncated; the reader returns only
// the latest snapshot. Server-side only (META_PAGE_TOKEN). INSTAGRAM only (FB per-post
// like/comment counts need Page Public Content Access; LinkedIn by-type comes from its import).

import { config, hasSource } from '../config.js';
import { q, supabaseConfigured } from '../providers/supabase.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const MEDIA_LIMIT = 24;          // recent posts sampled (matches the IG 24-post window used elsewhere)
const REFRESH_AFTER_HOURS = 20;  // pull at most ~once a day

const SRC =
  'Live (Meta Graph API → public.meta_ig_by_type): recent Instagram posts grouped by content ' +
  'format, with average per-post reach + engagement. Refreshed at most once a day (per-post ' +
  'reach is one Graph call per post). Instagram only.';

async function graphGet(path, params) {
  const url = new URL(GRAPH + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error ? j.error.message : `HTTP ${r.status}`);
  return j;
}

function mediaLabel(t) {
  if (!t) return 'Other';
  const u = String(t).toUpperCase();
  if (u === 'VIDEO' || u === 'REELS') return 'Reel / Video';
  if (u === 'CAROUSEL_ALBUM') return 'Carousel';
  if (u === 'IMAGE') return 'Image';
  return t;
}

// Fetch recent media + per-post reach, group by format, upsert one row per format.
async function refresh(igId, token) {
  const media = await graphGet(`/${igId}/media`, {
    fields: 'id,media_type,like_count,comments_count',
    limit: String(MEDIA_LIMIT),
    access_token: token,
  });
  const arr = media.data || [];
  if (!arr.length) return false;

  // Per-post reach — one call each (bounded by MEDIA_LIMIT), run in parallel; a media type
  // that doesn't expose reach just leaves that post out of the reach average.
  const reaches = await Promise.all(arr.map(async (m) => {
    try {
      const j = await graphGet(`/${m.id}/insights`, { metric: 'reach', access_token: token });
      const v = j.data && j.data[0] && j.data[0].values && j.data[0].values[0];
      return v && v.value != null ? Number(v.value) : null;
    } catch {
      return null;
    }
  }));

  const groups = {}; // label -> { count, reachSum, reachCount, engSum }
  arr.forEach((m, i) => {
    const label = mediaLabel(m.media_type);
    const eng = (Number(m.like_count) || 0) + (Number(m.comments_count) || 0);
    if (!groups[label]) groups[label] = { count: 0, reachSum: 0, reachCount: 0, engSum: 0 };
    const g = groups[label];
    g.count += 1;
    g.engSum += eng;
    if (reaches[i] != null) { g.reachSum += reaches[i]; g.reachCount += 1; }
  });

  const now = new Date().toISOString();
  for (const [label, g] of Object.entries(groups)) {
    const avgReach = g.reachCount ? Math.round(g.reachSum / g.reachCount) : null;
    const avgEng = g.count ? Math.round((g.engSum / g.count) * 10) / 10 : null;
    await q(
      `insert into public.meta_ig_by_type (media_label, post_count, avg_reach, avg_engagement, captured_at)
       values ($1, $2, $3, $4, $5)
       on conflict (media_label) do update
         set post_count = excluded.post_count,
             avg_reach = excluded.avg_reach,
             avg_engagement = excluded.avg_engagement,
             captured_at = excluded.captured_at`,
      [label, g.count, avgReach, avgEng, now],
    );
  }
  return true;
}

export async function getMetaIgByType() {
  if (!supabaseConfigured()) {
    return { data: [], meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' } };
  }

  // Staleness gate — only pay the ~24 Graph calls when the snapshot is > REFRESH_AFTER hours old.
  if (hasSource('meta')) {
    try {
      const rows = await q(`select max(captured_at) as m from public.meta_ig_by_type`);
      const last = rows && rows[0] && rows[0].m ? new Date(rows[0].m).getTime() : 0;
      if (Date.now() - last > REFRESH_AFTER_HOURS * 3600 * 1000) {
        await refresh(config.meta.igId, config.meta.pageToken);
      }
    } catch (err) {
      console.error('[meta-ig-by-type] refresh failed:', err.message);
    }
  }

  const rows = await q(
    `select media_label, post_count, avg_reach, avg_engagement
       from public.meta_ig_by_type
      where captured_at = (select max(captured_at) from public.meta_ig_by_type)
      order by avg_reach desc nulls last`,
  );
  const data = rows.map((r) => ({
    type: r.media_label,
    count: Number(r.post_count) || 0,
    avgReach: r.avg_reach == null ? null : Number(r.avg_reach),
    avgEngagement: r.avg_engagement == null ? null : Number(r.avg_engagement),
  }));

  return {
    data,
    meta: {
      status: data.length ? 'live' : 'pending',
      source: SRC,
      note: data.length
        ? `${data.length} Instagram content formats by average per-post reach.`
        : 'No data yet — the daily snapshot has not run.',
    },
  };
}
