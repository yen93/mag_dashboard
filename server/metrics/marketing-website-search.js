// Marketing — Website & Search.
//
// Live metrics for public/website_search.html:
//
// 1. Primary enquiries (total / organic / cpc):
//    DEFINITION (per the owner): counts ONLY leads that correspond to a real,
//    existing saved ActiveCampaign contact. Source = public.ga4_ac_contact_source
//    (GA4 & Ads leads matched to AC), restricted to rows whose contact_id actually
//    exists in public.activecampaign_contacts — this drops the synthetic
//    'roas-<deal_id>' rows and anything not backed by a saved contact. One matched
//    contact = one enquiry.
//
// 2. organicAll ("Organic enquiries incl. unmatched"):
//    Organic-medium website FORM conversions from public.ga4_ac_event_matches,
//    counting EVERY organic form event — matched to an AC contact OR not.
//    Enquiry form events only (form_submit / Contact_Form_Submit_Alt /
//    form_submissions / Form_submission_thankyou_1).
//
// 3. Website sessions + Visits from AI tools:
//    Latest weekly snapshot per Australian FY from
//    public.ga4_website_traffic_snapshots (filled weekly by the
//    ga4-website-traffic-sync edge function via the GA4 Data API runReport).
//
// 4. New Google reviews:
//    Per-FY count and average star rating from public.google_reviews (by
//    review_create_time).
//
// Phone enquiries has no live source yet and renders a "pending" chip.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC =
  'Live (Supabase): website sessions + AI-tool visits from public.ga4_website_traffic_snapshots ' +
  '(weekly GA4 Data API snapshot per AU FY); enquiries (total/organic/cpc) = GA4 & Ads leads ' +
  '(ga4_ac_contact_source) matched to an existing saved AC contact; organic incl. unmatched = ' +
  'all organic-medium website form conversions from ga4_ac_event_matches; Google reviews from ' +
  'public.google_reviews (review_create_time, star_rating).';

// Primary enquiries = AC-matched contacts, split by medium, per FY.
const MATCHED_SQL = `
  WITH e AS (
    SELECT
      cs.fy,
      CASE WHEN cs.fy ~ '^FY[0-9]{2}$' THEN 2000 + right(cs.fy, 2)::int END AS fy_end,
      lower(coalesce(cs.medium, '')) AS med
    FROM public.ga4_ac_contact_source cs
    JOIN public.activecampaign_contacts c ON c.id::text = cs.contact_id
    WHERE cs.fy IS NOT NULL
  )
  SELECT
    fy,
    fy_end                                   AS "fyEnd",
    count(*)                                 AS total,
    count(*) FILTER (WHERE med = 'organic')  AS organic,
    count(*) FILTER (WHERE med LIKE '%cpc%') AS cpc
  FROM e
  GROUP BY fy, fy_end
  ORDER BY fy_end`;

// Organic enquiries INCL. unmatched = every organic-medium website form conversion
// (matched to an AC contact or not), per FY, from the event-level matches table.
const ORGANIC_ALL_SQL = `
  WITH e AS (
    SELECT
      event_count,
      (extract(year FROM event_time)::int
        + CASE WHEN extract(month FROM event_time) >= 7 THEN 1 ELSE 0 END) AS fy_end
    FROM public.ga4_ac_event_matches
    WHERE medium = 'organic'
      AND event_kind = 'ga4_form'
      AND event_name IN ('form_submit', 'Contact_Form_Submit_Alt', 'form_submissions', 'Form_submission_thankyou_1')
  )
  SELECT
    'FY' || lpad((fy_end - 2000)::text, 2, '0') AS fy,
    fy_end                                       AS "fyEnd",
    coalesce(sum(event_count), 0)                AS organic_all
  FROM e
  GROUP BY fy_end
  ORDER BY fy_end`;

// Latest weekly snapshot per FY for Website sessions + Visits from AI tools.
const TRAFFIC_SNAPSHOT_SQL = `
  SELECT DISTINCT ON (fy_end)
    'FY' || lpad((fy_end - 2000)::text, 2, '0') AS fy,
    fy_end                                       AS "fyEnd",
    to_char(snapshot_date, 'YYYY-MM-DD')         AS "snapshotDate",
    website_sessions                             AS sessions,
    ai_tool_visits                               AS "aiVisits",
    ai_sources_breakdown                         AS "aiSources"
  FROM public.ga4_website_traffic_snapshots
  ORDER BY fy_end, snapshot_date DESC`;

// Google reviews count + average star rating per AU FY.
const REVIEWS_SQL = `
  WITH r AS (
    SELECT
      (extract(year FROM review_create_time)::int
        + CASE WHEN extract(month FROM review_create_time) >= 7 THEN 1 ELSE 0 END) AS fy_end,
      NULLIF(star_rating, '')::numeric AS stars
    FROM public.google_reviews
    WHERE review_create_time IS NOT NULL
  )
  SELECT
    'FY' || lpad((fy_end - 2000)::text, 2, '0') AS fy,
    fy_end                                       AS "fyEnd",
    count(*)                                     AS reviews,
    round(avg(stars), 2)                         AS "avgStars"
  FROM r
  GROUP BY fy_end
  ORDER BY fy_end`;

// ---- Custom date-range variants (day-level; $1=from, $2=to, 'YYYY-MM-DD' or null) ----
// Only the genuinely dated sources are range-filterable: AC-matched enquiries (cs.cdate),
// organic-incl-unmatched (event_time), Google reviews (review_create_time). The weekly
// cumulative traffic snapshot (sessions / AI-tool visits) has no sub-FY history, so it is
// NOT computed here — the page greys those tiles while a custom range is active.
const MATCHED_RANGE_SQL = `
  WITH e AS (
    SELECT lower(coalesce(cs.medium, '')) AS med
    FROM public.ga4_ac_contact_source cs
    JOIN public.activecampaign_contacts c ON c.id::text = cs.contact_id
    WHERE cs.cdate IS NOT NULL
      AND ($1::date IS NULL OR cs.cdate::date >= $1::date)
      AND ($2::date IS NULL OR cs.cdate::date <= $2::date)
  )
  SELECT count(*)                                 AS total,
         count(*) FILTER (WHERE med = 'organic')  AS organic,
         count(*) FILTER (WHERE med LIKE '%cpc%') AS cpc
  FROM e`;

const ORGANIC_ALL_RANGE_SQL = `
  SELECT coalesce(sum(event_count), 0) AS organic_all
  FROM public.ga4_ac_event_matches
  WHERE medium = 'organic' AND event_kind = 'ga4_form'
    AND event_name IN ('form_submit', 'Contact_Form_Submit_Alt', 'form_submissions', 'Form_submission_thankyou_1')
    AND ($1::date IS NULL OR event_time::date >= $1::date)
    AND ($2::date IS NULL OR event_time::date <= $2::date)`;

const REVIEWS_RANGE_SQL = `
  WITH r AS (
    SELECT NULLIF(star_rating, '')::numeric AS stars
    FROM public.google_reviews
    WHERE review_create_time IS NOT NULL
      AND ($1::date IS NULL OR review_create_time::date >= $1::date)
      AND ($2::date IS NULL OR review_create_time::date <= $2::date)
  )
  SELECT count(*) AS reviews, round(avg(stars), 2) AS "avgStars" FROM r`;

async function rangeRollup(from, to) {
  const n = (v) => Number(v) || 0;
  const [m, oa, rv] = await Promise.all([
    q(MATCHED_RANGE_SQL, [from, to]).then((r) => r[0] || {}).catch(() => ({})),
    q(ORGANIC_ALL_RANGE_SQL, [from, to]).then((r) => r[0] || {}).catch(() => ({})),
    q(REVIEWS_RANGE_SQL, [from, to]).then((r) => r[0] || {}).catch(() => ({})),
  ]);
  return {
    from, to,
    total: n(m.total), organic: n(m.organic), cpc: n(m.cpc),
    organicAll: n(oa.organic_all),
    reviews: n(rv.reviews),
    avgStars: rv.avgStars != null ? Number(rv.avgStars) : null,
    sessions: null, aiVisits: null, // snapshot-only — greyed on the page under a custom range
  };
}

export async function getWebsiteSearch(opts = {}) {
  const { from = null, to = null } = opts || {};
  if (!supabaseConfigured()) {
    return {
      byFy: {},
      total: {
        total: 0, organic: 0, cpc: 0, organicAll: 0,
        sessions: null, aiVisits: null, reviews: 0, avgStars: null,
      },
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' },
    };
  }
  const n = (v) => Number(v) || 0;
  const [matched, organicAll, trafficRows, reviewRows] = await Promise.all([
    q(MATCHED_SQL),
    q(ORGANIC_ALL_SQL),
    q(TRAFFIC_SNAPSHOT_SQL).catch(() => []), // graceful fallback if migration not yet applied
    q(REVIEWS_SQL).catch(() => []),
  ]);

  const byFy = {};                                  // keyed by "FY27"
  const total = {
    total: 0, organic: 0, cpc: 0, organicAll: 0,
    sessions: trafficRows.length ? 0 : null,
    aiVisits: trafficRows.length ? 0 : null,
    reviews: 0, avgStars: null,
  };

  // Ensure a record exists for an FY key (from any source).
  const ensure = (fy, fyEnd) => {
    if (!byFy[fy]) {
      byFy[fy] = {
        total: 0, organic: 0, cpc: 0, organicAll: 0,
        sessions: null, aiVisits: null, reviews: 0, avgStars: null,
        fyEnd: n(fyEnd),
      };
    }
    return byFy[fy];
  };

  for (const r of matched) {
    const rec = ensure(r.fy, r.fyEnd);
    rec.total = n(r.total); rec.organic = n(r.organic); rec.cpc = n(r.cpc);
    total.total += rec.total; total.organic += rec.organic; total.cpc += rec.cpc;
  }
  for (const r of organicAll) {
    const rec = ensure(r.fy, r.fyEnd);
    rec.organicAll = n(r.organic_all);
    total.organicAll += rec.organicAll;
  }
  for (const r of trafficRows) {
    const rec = ensure(r.fy, r.fyEnd);
    rec.sessions = n(r.sessions);
    rec.aiVisits = n(r.aiVisits);
    rec.snapshotDate = r.snapshotDate || null;
    total.sessions = (total.sessions || 0) + rec.sessions;
    total.aiVisits = (total.aiVisits || 0) + rec.aiVisits;
  }

  let weightedStars = 0;
  for (const r of reviewRows) {
    const cnt = n(r.reviews);
    const stars = r.avgStars != null ? Number(r.avgStars) : null;
    total.reviews += cnt;
    if (stars != null) weightedStars += stars * cnt;
    if (r.fyEnd >= 2022) {
      const rec = ensure(r.fy, r.fyEnd);
      rec.reviews = cnt;
      rec.avgStars = stars;
    }
  }
  if (total.reviews > 0) {
    total.avgStars = Math.round((weightedStars / total.reviews) * 100) / 100;
  }

  const range = (from || to) ? await rangeRollup(from, to) : null;

  return { byFy, total, range, meta: { status: 'live', source: SRC, note: null } };
}
