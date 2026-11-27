// Marketing — Enquiries traced to social (Social Platforms KPI cards).
//
// Counts NEW CRM contacts whose captured UTM source is a social channel, straight from
// public.ac_new_contacts_src (the ActiveCampaign new-contact source mirror). This backs the
// "Enquiries traced to social" KPI tile on every platform tab of social_platforms.html
// (All accounts / JC's LinkedIn / MAG LinkedIn / Facebook / Instagram).
//
//   src_utm_source IN ('linkedin','facebook','instagram')   (matched case-insensitively)
//
// Each contact is attributed to an Australian financial year by its creation date (cdate):
// FY ends in the calendar year of cdate, +1 when cdate is in July–December — identical to the
// `fyEnd` convention used by indirect-deals.js / the rest of the dashboard. The page picks the
// right number for the selected FY toggle (or the all-FY total when "All" is selected).
//
// NB UTM source cannot separate the two LinkedIn accounts (JC's profile vs the MAG company
// page), so both LinkedIn tabs share the single `linkedin` figure — the tile's info note says so.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC =
  'Live (Supabase): public.ac_new_contacts_src — new ActiveCampaign contacts whose captured ' +
  "UTM source is linkedin / facebook / instagram, counted by the contact's creation financial year.";

// One row per (platform, FY). fy_end is NULL for the rare contact with no cdate — those still
// count toward the platform total but not toward any single financial year.
const SQL = `
  SELECT
    CASE
      WHEN lower(src_utm_source) = 'linkedin'  THEN 'linkedin'
      WHEN lower(src_utm_source) = 'facebook'  THEN 'facebook'
      WHEN lower(src_utm_source) = 'instagram' THEN 'instagram'
    END AS platform,
    (CASE WHEN cdate IS NULL THEN NULL
          ELSE extract(year from cdate)::int
               + CASE WHEN extract(month from cdate) >= 7 THEN 1 ELSE 0 END
     END) AS fy_end,
    count(*)::int AS n
  FROM public.ac_new_contacts_src
  WHERE lower(src_utm_source) IN ('linkedin', 'facebook', 'instagram')
  GROUP BY 1, 2`;

const PLATFORMS = ['linkedin', 'facebook', 'instagram'];

export async function getSocialEnquiries() {
  const empty = () => ({ total: 0, byFy: {} });

  if (!supabaseConfigured()) {
    const byPlatform = {};
    PLATFORMS.forEach((p) => { byPlatform[p] = empty(); });
    return {
      byPlatform,
      fyEnds: [],
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' },
    };
  }

  const rows = await q(SQL);
  const byPlatform = {};
  PLATFORMS.forEach((p) => { byPlatform[p] = empty(); });

  const fyEnds = new Set();
  for (const r of rows) {
    const p = r.platform;
    if (!byPlatform[p]) continue;             // defensive — CASE only yields the three keys
    const n = Number(r.n) || 0;
    byPlatform[p].total += n;
    if (r.fy_end != null) {
      const fy = Number(r.fy_end);
      byPlatform[p].byFy[fy] = (byPlatform[p].byFy[fy] || 0) + n;
      fyEnds.add(fy);
    }
  }

  const grand = PLATFORMS.reduce((s, p) => s + byPlatform[p].total, 0);

  return {
    byPlatform,
    fyEnds: [...fyEnds].sort((a, b) => a - b),
    meta: {
      status: grand > 0 ? 'live' : 'pending',
      source: SRC,
      note: grand > 0
        ? `${grand} social-tagged enquiries (LinkedIn ${byPlatform.linkedin.total}, ` +
          `Facebook ${byPlatform.facebook.total}, Instagram ${byPlatform.instagram.total}).`
        : 'No contacts with a social UTM source found in ac_new_contacts_src.',
    },
  };
}
