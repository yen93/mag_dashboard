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

// Per-deal lists behind the three count cards — powers the click-through modal on
// nurture_events.html (click card 1/2/3 → see the deals counted). The client
// FY/range-filters these the same way the cards are filtered:
//   • card 1 "keynote clients"   → the `keynote` rows
//   • card 2 "offsite enquiries" → the `offsite` rows (all)
//   • card 3 "offsites booked"   → the `offsite` rows where won
// So the won offsite deals are NOT returned twice — the client derives card 3 from
// the offsite rows' `won` flag. Columns mirror the counts' tables exactly.
const DEALS_SQL = `
  SELECT 'keynote' AS card,
         d.id AS deal_id,
         coalesce(nullif(a.name, ''), nullif(d.organization, ''), split_part(d.title, ' // ', 1)) AS org,
         d.title AS title,
         ${FY('d.cdate')} AS fy_end,
         to_char(d.cdate, 'YYYY-MM-DD') AS date,
         public.ac_value_aud(d.value, d.currency) AS value,
         true AS won,
         'Won' AS status
  FROM public.activecampaign_deals d
  LEFT JOIN public.activecampaign_accounts a ON a.id = d.organization
  WHERE d."group" = '3' AND d.status = 1 AND d.cdate IS NOT NULL
  UNION ALL
  SELECT 'offsite' AS card,
         p.deal_id AS deal_id,
         coalesce(nullif(p.organization, ''), nullif(p.contact_name, ''), split_part(p.title, ' // ', 1)) AS org,
         p.title AS title,
         ${FY('p.cdate')} AS fy_end,
         to_char(p.cdate, 'YYYY-MM-DD') AS date,
         p.value_aud AS value,
         (p.status = 1) AS won,
         coalesce(p.status_label, '') AS status
  FROM public.post_conference_deals p
  WHERE p.cdate IS NOT NULL
  ORDER BY date DESC`;

// Custom date-range variant — same counts, but filtered to an arbitrary [from,to]
// (inclusive) on the deal cdate instead of grouped by FY. Day-level: both deal
// tables are row-per-deal with a real cdate. $1=from, $2=to ('YYYY-MM-DD' or null).
const RANGE_SQL = `
  WITH keynote AS (
    SELECT count(*) FILTER (WHERE status = 1) AS keynote_clients
    FROM public.activecampaign_deals
    WHERE "group" = '3' AND cdate IS NOT NULL
      AND ($1::date IS NULL OR cdate::date >= $1::date)
      AND ($2::date IS NULL OR cdate::date <= $2::date)
  ),
  offsite AS (
    SELECT count(*) AS enquiries, count(*) FILTER (WHERE status = 1) AS booked
    FROM public.post_conference_deals
    WHERE cdate IS NOT NULL
      AND ($1::date IS NULL OR cdate::date >= $1::date)
      AND ($2::date IS NULL OR cdate::date <= $2::date)
  )
  SELECT keynote.keynote_clients AS "keynoteClients",
         offsite.enquiries       AS "offsiteEnquiries",
         offsite.booked          AS "offsiteBooked"
  FROM keynote, offsite`;

export async function getMarketingNurtureEvents(opts = {}) {
  const { from = null, to = null } = opts || {};
  if (!supabaseConfigured()) {
    return {
      byFy: [], total: { keynoteClients: 0, offsiteEnquiries: 0, offsiteBooked: 0 },
      deals: { keynote: [], offsite: [] },
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' },
    };
  }
  const n = (v) => Number(v) || 0;
  const rows = await q(CARDS_SQL);

  // Per-deal lists for the card drill-down modal (one query, both cards).
  const dealRows = await q(DEALS_SQL);
  const toDeal = (r) => ({
    dealId: r.deal_id,
    org: r.org || '',
    title: r.title || '',
    fyEnd: n(r.fy_end),
    date: r.date,
    value: n(r.value),
    won: r.won === true,
    status: r.status || '',
  });
  const deals = {
    keynote: dealRows.filter((r) => r.card === 'keynote').map(toDeal),
    offsite: dealRows.filter((r) => r.card === 'offsite').map(toDeal),
  };

  // Custom date-range roll-up (day-level), only when a range was requested.
  let range = null;
  if (from || to) {
    const rr = (await q(RANGE_SQL, [from, to]))[0] || {};
    range = {
      from, to,
      keynoteClients: n(rr.keynoteClients),
      offsiteEnquiries: n(rr.offsiteEnquiries),
      offsiteBooked: n(rr.offsiteBooked),
    };
  }

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

  return { byFy, total, range, deals, meta: { status: 'live', source: SRC, note: null } };
}
