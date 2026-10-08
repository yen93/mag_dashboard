// Sales page — Top-Line Header cards, date-range aware.
//
// Reads public.ac_deals_ytd (ActiveCampaign deals created this calendar year,
// mirrored by sales_dashboard/scripts/sync_ac_deals.py). Every card is
// filtered on the deal's CREATED date (Australia/Sydney calendar day) using the
// optional ?from / ?to (YYYY-MM-DD, inclusive) passed from the page's
// date-range toolbar. No range → the whole table (= YTD).
//
// Card definitions (agreed with the sales team):
//   • Total Income        — SUM(deal_value) of WON deals
//   • Direct vs Indirect  — share of WON deal value by "Deal Source?"
//                           (deals with no Deal Source are left out of the %)
//   • Speaking Enquiries  — COUNT where is_inbound_inquiry (contact tagged
//                           "[SALES] Inbound Enquiry")
//   • Bureau / Tailor     — COUNT where is_bureau / is_tailor
//   • Inbound / Outbound  — COUNT by the "Inbound/ Outbound?" deal field
//                           (Outbound = both "Outbound - …" options)

import { q, supabaseConfigured } from '../providers/supabase.js';
import { live, pending } from '../lib/metric.js';

const SRC = 'ActiveCampaign → ac_deals_ytd';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SQL = `
  WITH d AS (
    SELECT * FROM public.ac_deals_ytd
    WHERE ($1::date IS NULL OR (deal_created_at AT TIME ZONE 'Australia/Sydney')::date >= $1::date)
      AND ($2::date IS NULL OR (deal_created_at AT TIME ZONE 'Australia/Sydney')::date <= $2::date)
  )
  SELECT
    count(*)::int                                                                   AS deals,
    coalesce(sum(deal_value) FILTER (WHERE status = 'won'), 0)::float8              AS won_value,
    count(*) FILTER (WHERE status = 'won')::int                                     AS won_deals,
    coalesce(sum(deal_value) FILTER (WHERE status = 'won' AND direct_or_indirect ILIKE 'direct%'), 0)::float8   AS direct_value,
    coalesce(sum(deal_value) FILTER (WHERE status = 'won' AND direct_or_indirect ILIKE 'indirect%'), 0)::float8 AS indirect_value,
    count(*) FILTER (WHERE is_inbound_inquiry)::int                                 AS speaking,
    count(*) FILTER (WHERE is_bureau)::int                                          AS bureau,
    count(*) FILTER (WHERE is_tailor)::int                                          AS tailor,
    count(*) FILTER (WHERE inbound_or_outbound ILIKE 'inbound%')::int               AS inbound,
    count(*) FILTER (WHERE inbound_or_outbound ILIKE 'outbound%')::int              AS outbound,
    max(synced_at)                                                                  AS synced_at
  FROM d`;

/** Validate a YYYY-MM-DD string; anything else → null (no bound). */
export function cleanDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !isNaN(Date.parse(s)) ? s : null;
}

export async function getToplineCards({ from = null, to = null } = {}) {
  from = cleanDate(from);
  to = cleanDate(to);
  if (!supabaseConfigured()) return notConfigured(from, to);

  const [r] = await q(SQL, [from, to]);
  const rangeTxt = from || to ? `deals created ${from || 'start of year'} → ${to || 'today'}` : 'all deals created this year';

  const diTotal = r.direct_value + r.indirect_value;
  const directPct = diTotal > 0 ? Math.round((r.direct_value / diTotal) * 100) : null;
  const indirectPct = directPct == null ? null : 100 - directPct;

  return {
    asOf: new Date().toISOString(),
    syncedAt: r.synced_at,
    range: { from, to },
    cards: {
      totalIncome: live(r.won_value, 'currency', {
        source: SRC,
        note: `Sum of deal value for ${r.won_deals} WON deals (${rangeTxt}). CRM-contracted value, not billed revenue.`,
      }),
      directIndirect: {
        ...live(directPct == null ? null : `${directPct}% / ${indirectPct}%`, 'text', {
          source: SRC,
          note: `Share of WON deal value by "Deal Source?" (${rangeTxt}). Won deals without a Deal Source are excluded.`,
        }),
        directPct, indirectPct, directValue: r.direct_value, indirectValue: r.indirect_value,
      },
      speakingEnquiries: live(r.speaking, 'count', {
        source: SRC, note: `Deals whose primary contact is tagged "[SALES] Inbound Enquiry" (${rangeTxt}).`,
      }),
      bureau: live(r.bureau, 'count', {
        source: SRC, note: `Deals in the BUREAU ENQUIRY stage of the LIV pipeline (${rangeTxt}).`,
      }),
      tailor: live(r.tailor, 'count', {
        source: SRC, note: `Deals in The Tailor pipeline (${rangeTxt}).`,
      }),
      inbound: live(r.inbound, 'count', {
        source: SRC, note: `Deals with "Inbound/ Outbound?" = Inbound Enquiry (${rangeTxt}).`,
      }),
      outbound: live(r.outbound, 'count', {
        source: SRC, note: `Deals with "Inbound/ Outbound?" = any Outbound option (${rangeTxt}).`,
      }),
    },
  };
}

function notConfigured(from, to) {
  const note = 'Supabase not configured (set SUPABASE_DB_URL).';
  const p = (unit) => pending(unit, { source: SRC, note });
  return {
    asOf: new Date().toISOString(),
    syncedAt: null,
    range: { from, to },
    cards: {
      totalIncome: p('currency'),
      directIndirect: p('text'),
      speakingEnquiries: p('count'),
      bureau: p('count'),
      tailor: p('count'),
      inbound: p('count'),
      outbound: p('count'),
    },
  };
}
