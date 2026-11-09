// Marketing — Nurture & Events cards (public/nurture_events.html).
//
// Three live, FY-aware counts (the page computes a fourth card, the ratio, from
// these). FY = the deal's creation date (cdate), Australian FY (Jul–Jun,
// END-year: FY27 = Jul 2026 – Jun 2027) — the same framing the rest of Marketing
// uses. LIVE, computed at request time from Supabase.
//
//   • keynoteClients   "Past keynote clients in nurture"
//       = WON deals (status=1) in pipeline 3 ("Keynotes/Workshops/Immersive (LIV)"),
//         straight from the daily-synced deal mirror public.activecampaign_deals.
//   • offsiteEnquiries "Offsite enquiries from past clients"
//       = ALL deals (any status) in pipeline 17 ("Trojan Horse: Post-Conf"),
//         from the public.post_conference_deals cache.
//   • offsiteBooked    "Offsites booked by past clients"
//       = WON deals (status=1) in pipeline 17, from public.post_conference_deals.
//
// The page's 4th card, "Keynote → Offsite conversion", = offsiteBooked ÷
// keynoteClients, computed client-side per FY.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC =
  'Live (Supabase): keynote clients = WON pipeline-3 deals (activecampaign_deals); ' +
  'offsite enquiries = ALL pipeline-17 deals, offsite bookings = WON pipeline-17 deals ' +
  '(post_conference_deals cache). FY from the deal cdate.';

// AU financial-year END year from a date column (calendar year + 1 if month >= July).
const FY = (col) =>
  `extract(year FROM ${col})::int + CASE WHEN extract(month FROM ${col}) >= 7 THEN 1 ELSE 0 END`;

const CARDS_SQL = `
  WITH keynote AS (
    SELECT ${FY('cdate')} AS fy_end,
           count(*) FILTER (WHERE status = 1) AS keynote_clients
    FROM public.activecampaign_deals
    WHERE "group" = '3' AND cdate IS NOT NULL
    GROUP BY 1
  ),
  offsite AS (
    SELECT ${FY('cdate')} AS fy_end,
           count(*)                    AS enquiries,
           count(*) FILTER (WHERE status = 1) AS booked
    FROM public.post_conference_deals
    WHERE cdate IS NOT NULL
    GROUP BY 1
  )
  SELECT coalesce(keynote.fy_end, offsite.fy_end)      AS "fyEnd",
         coalesce(keynote.keynote_clients, 0)          AS "keynoteClients",
         coalesce(offsite.enquiries, 0)                AS "offsiteEnquiries",
         coalesce(offsite.booked, 0)                   AS "offsiteBooked"
  FROM keynote FULL OUTER JOIN offsite ON keynote.fy_end = offsite.fy_end
  ORDER BY 1`;

export async function getMarketingNurtureEvents() {
  if (!supabaseConfigured()) {
    return {
      byFy: [], total: { keynoteClients: 0, offsiteEnquiries: 0, offsiteBooked: 0 },
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' },
    };
  }
  const n = (v) => Number(v) || 0;
  const rows = await q(CARDS_SQL);

  const byFy = rows.map((r) => ({
    fyEnd: n(r.fyEnd),
    fy: 'FY' + String(r.fyEnd).slice(-2),
    keynoteClients: n(r.keynoteClients),
    offsiteEnquiries: n(r.offsiteEnquiries),
    offsiteBooked: n(r.offsiteBooked),
  }));

  // All-years roll-up: deals partition by their creation FY, so summing the
  // per-FY totals is the all-years total.
  const total = byFy.reduce(
    (a, r) => ({
      keynoteClients: a.keynoteClients + r.keynoteClients,
      offsiteEnquiries: a.offsiteEnquiries + r.offsiteEnquiries,
      offsiteBooked: a.offsiteBooked + r.offsiteBooked,
    }),
    { keynoteClients: 0, offsiteEnquiries: 0, offsiteBooked: 0 },
  );

  return { byFy, total, meta: { status: 'live', source: SRC, note: null } };
}
