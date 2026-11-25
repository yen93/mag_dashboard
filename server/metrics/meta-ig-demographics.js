// Marketing — Instagram follower demographics (Social Platforms tab).
//
// Backs two charts: "Audience — age & gender" (age×gender pyramid) and "Top locations".
// A LIFETIME snapshot of the CURRENT follower base from the Meta Graph API
// (follower_demographics, metric_type=total_value, breakdown=age,gender / city) — a current
// state, not a time series, so it's a plain request-time fetch (cached ~10 min by the route),
// no cache table. Server-side only (META_PAGE_TOKEN); degrades to pending if the token is
// unset or Meta returns nothing.
//
// INSTAGRAM ONLY — Facebook's audience demographics (page_fans_gender_age / _country / _city)
// are deprecated by Meta's New-Pages API, and seniority / industry don't exist on Meta at all
// (those are LinkedIn attributes). follower_demographics needs >= 100 followers (MAG IG has ~1.9k).

import { config, hasSource } from '../config.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const TOP_CITIES = 8;
const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];

const SRC =
  'Live (Meta Graph API): Instagram follower_demographics — a lifetime snapshot of the current ' +
  'follower base (age×gender + top cities). Instagram only; Facebook audience demographics are ' +
  'deprecated by Meta, and seniority/industry are LinkedIn-only concepts.';

async function graphGet(path, params) {
  const url = new URL(GRAPH + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error ? j.error.message : `HTTP ${r.status}`);
  return j;
}

function breakdown(j) {
  const bd = j.data && j.data[0] && j.data[0].total_value && j.data[0].total_value.breakdowns
    && j.data[0].total_value.breakdowns[0];
  return bd ? { keys: bd.dimension_keys || [], results: bd.results || [] } : null;
}

export async function getMetaIgDemographics() {
  if (!hasSource('meta')) {
    return { ageGender: [], locations: [], meta: { status: 'pending', source: SRC, note: 'META_PAGE_TOKEN not set.' } };
  }
  const token = config.meta.pageToken;
  const igId = config.meta.igId;
  let ageGender = [];
  let locations = [];

  // Age × gender (one combined breakdown → the pyramid). Gender 'U' (undeclared) is dropped.
  try {
    const j = await graphGet(`/${igId}/insights`, {
      metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value',
      breakdown: 'age,gender', access_token: token,
    });
    const bd = breakdown(j);
    if (bd) {
      const ai = bd.keys.indexOf('age');
      const gi = bd.keys.indexOf('gender');
      const byAge = {};
      for (const r of bd.results) {
        const age = r.dimension_values[ai];
        const g = r.dimension_values[gi];
        if (!byAge[age]) byAge[age] = { age, female: 0, male: 0 };
        if (g === 'F') byAge[age].female += Number(r.value) || 0;
        else if (g === 'M') byAge[age].male += Number(r.value) || 0;
      }
      ageGender = AGE_ORDER.filter((a) => byAge[a]).map((a) => byAge[a]);
    }
  } catch (err) {
    console.error('[meta-ig-demographics] age/gender failed:', err.message);
  }

  // Top cities → share of the located audience.
  try {
    const j = await graphGet(`/${igId}/insights`, {
      metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value',
      breakdown: 'city', access_token: token,
    });
    const bd = breakdown(j);
    if (bd) {
      const total = bd.results.reduce((s, r) => s + (Number(r.value) || 0), 0) || 1;
      locations = bd.results
        .map((r) => ({ place: r.dimension_values[0], value: Number(r.value) || 0 }))
        .sort((a, b) => b.value - a.value)
        .slice(0, TOP_CITIES)
        .map((r) => ({ place: r.place, share: Math.round((r.value / total) * 1000) / 10 }));
    }
  } catch (err) {
    console.error('[meta-ig-demographics] city failed:', err.message);
  }

  const live = ageGender.length > 0 || locations.length > 0;
  return {
    ageGender,
    locations,
    meta: {
      status: live ? 'live' : 'pending',
      source: SRC,
      note: live ? 'Instagram follower demographics (lifetime snapshot).' : 'No demographics returned by Meta.',
    },
  };
}
