// Marketing — EDM (ActiveCampaign Contact Performance + All Campaigns Performance).
//
// Backs public/edm.html (/api/marketing/edm). Plain SELECT of the latest row of
// public.edm_report_metrics — a weekly snapshot cache filled by the Claude Code
// routine `edm-sync` (routines/edm-sync.md), which pulls the contact KPIs, list
// health (per-list active/total), the engagement segmentation and the account-level
// campaign summary + per-campaign rows from the ActiveCampaign MCP. The server only
// SELECTs the latest row — no source calls at request time.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC =
  'Live: ActiveCampaign, via a weekly Supabase snapshot (edm_report_metrics, filled by ' +
  'the edm-sync routine using the AC MCP). Contact totals, list health, engagement ' +
  'segmentation and the campaign report are all from ActiveCampaign.';

// Latest snapshot row (most recent captured_at wins).
const LATEST_SQL = `
  SELECT total_contacts, active_contacts, nonactive_contacts, top_lists, segmentation,
         camp_count, camp_total_sends, camp_open_rate, camp_click_rate, camp_click_to_open_rate,
         camp_bounce_rate, camp_unsubscribe_rate, camp_total_unique_opens, camp_total_unique_clicks,
         camp_total_bounces, camp_total_unsubscribes, campaigns, captured_at
  FROM public.edm_report_metrics
  ORDER BY captured_at DESC
  LIMIT 1`;

// Contact-total history: the last snapshot of each day (the table is append-only, so this is the
// trail the Compare deltas on the Contact KPI cards read — a past snapshot vs the latest one).
const HISTORY_SQL = `
  SELECT DISTINCT ON (captured_at::date)
         to_char(captured_at::date, 'YYYY-MM-DD') AS d,
         total_contacts, active_contacts, nonactive_contacts
  FROM public.edm_report_metrics
  ORDER BY captured_at::date ASC, captured_at DESC`;

function pending(note) {
  return {
    contact: { total: null, active: null, nonactive: null, lists: [], segmentation: [] },
    campaigns: { summary: null, rows: [] },
    capturedAt: null,
    meta: { status: 'pending', source: SRC, note },
  };
}

export async function getEdmReport() {
  if (!supabaseConfigured()) return pending('Supabase not configured.');

  const rows = await q(LATEST_SQL);
  if (!rows.length) return pending('No snapshot yet — run the edm-sync routine.');

  const r = rows[0];
  const n = (v) => (v == null ? null : Number(v));
  let history = [];
  try {
    history = (await q(HISTORY_SQL)).map((h) => ({
      d: h.d, total: n(h.total_contacts), active: n(h.active_contacts), nonactive: n(h.nonactive_contacts),
    }));
  } catch (err) {
    console.error('[edm-report] history failed:', err.message);   // deltas just degrade to "no data"
  }

  return {
    contact: {
      total: n(r.total_contacts),
      active: n(r.active_contacts),
      nonactive: n(r.nonactive_contacts),
      history,   // [{d,total,active,nonactive}] oldest → newest, one per day
      // List health — top lists by total size, each as active / total (non_deleted).
      lists: (r.top_lists || []).map((l) => ({
        name: l.name,
        active: n(l.active != null ? l.active : l.active_subscribers),
        total: n(l.total != null ? l.total : l.total_subscribers),
      })),
      // Engagement segmentation — counts of the AC engagement tags.
      segmentation: (r.segmentation || []).map((s) => ({
        key: s.key,
        label: s.label,
        count: n(s.count),
        tag: s.tag,
        desc: s.desc,
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
