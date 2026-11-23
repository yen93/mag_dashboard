// Marketing — EDM (ActiveCampaign Contact Performance + All Campaigns Performance).
//
// Backs public/edm.html (/api/marketing/edm). Two data sources:
//  1. public.edm_report_metrics — a weekly snapshot cache (latest row) filled by the
//     Claude Code routine `edm-sync` (routines/edm-sync.md), which pulls the contact
//     KPIs, top lists, top tags and the account-level campaign summary + per-campaign
//     rows from the ActiveCampaign MCP. The server only SELECTs the latest row.
//  2. public.activecampaign_contacts (the daily-synced AC contact mirror) — the
//     "new contacts by month" growth bar is computed live here (grouped by cdate), so
//     it's always current without waiting for the weekly snapshot.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC =
  'Live: ActiveCampaign. Contact totals, top lists/tags and the campaign report come from a ' +
  'weekly Supabase snapshot (edm_report_metrics, via the AC MCP); the "new contacts by month" ' +
  'chart is computed live from the activecampaign_contacts mirror.';

// Latest snapshot row (most recent captured_at wins).
const LATEST_SQL = `
  SELECT total_contacts, active_contacts, nonactive_contacts, top_lists, top_tags,
         camp_count, camp_total_sends, camp_open_rate, camp_click_rate, camp_click_to_open_rate,
         camp_bounce_rate, camp_unsubscribe_rate, camp_total_unique_opens, camp_total_unique_clicks,
         camp_total_bounces, camp_total_unsubscribes, campaigns, captured_at
  FROM public.edm_report_metrics
  ORDER BY captured_at DESC
  LIMIT 1`;

// New contacts added per month over the last 12 months (current base, by cdate).
const BY_MONTH_SQL = `
  SELECT to_char(date_trunc('month', cdate), 'YYYY-MM') AS ym, count(*)::int AS added
  FROM public.activecampaign_contacts
  WHERE cdate >= (date_trunc('month', now()) - interval '11 months')
  GROUP BY 1
  ORDER BY 1`;

function pending(note) {
  return {
    contact: { total: null, active: null, nonactive: null, byMonth: [], topLists: [], topTags: [] },
    campaigns: { summary: null, rows: [] },
    capturedAt: null,
    meta: { status: 'pending', source: SRC, note },
  };
}

export async function getEdmReport() {
  if (!supabaseConfigured()) return pending('Supabase not configured.');

  const [rows, byMonth] = await Promise.all([
    q(LATEST_SQL),
    q(BY_MONTH_SQL).catch(() => []),
  ]);

  const n = (v) => (v == null ? null : Number(v));
  const months = (byMonth || []).map((r) => ({ ym: r.ym, added: n(r.added) }));

  if (!rows.length) {
    const p = pending('No snapshot yet — run the edm-sync routine.');
    p.contact.byMonth = months; // growth chart is live, show it even before the first snapshot
    return p;
  }

  const r = rows[0];
  return {
    contact: {
      total: n(r.total_contacts),
      active: n(r.active_contacts),
      nonactive: n(r.nonactive_contacts),
      byMonth: months,
      topLists: (r.top_lists || []).map((l) => ({
        name: l.name,
        activeSubscribers: n(l.active_subscribers),
      })),
      topTags: (r.top_tags || []).map((t) => ({
        tag: t.tag,
        subscriberCount: n(t.subscriber_count),
      })),
    },
    campaigns: {
      summary: {
        count: n(r.camp_count),
        totalSends: n(r.camp_total_sends),
        openRate: n(r.camp_open_rate),
        clickRate: n(r.camp_click_rate),
        clickToOpenRate: n(r.camp_click_to_open_rate),
        bounceRate: n(r.camp_bounce_rate),
        unsubscribeRate: n(r.camp_unsubscribe_rate),
        totalUniqueOpens: n(r.camp_total_unique_opens),
        totalUniqueClicks: n(r.camp_total_unique_clicks),
        totalBounces: n(r.camp_total_bounces),
        totalUnsubscribes: n(r.camp_total_unsubscribes),
      },
      rows: r.campaigns || [],
    },
    capturedAt: r.captured_at,
    meta: { status: 'live', source: SRC, note: null },
  };
}
