// Marketing — Email & Partners.
//
// Plain SELECT of public.email_partner_metrics (append-only weekly snapshots),
// backing public/email_partners.html (/api/marketing/email-partners). The data
// is produced by the Claude Code routine `email-partners-sync`
// (routines/email-partners-sync.md), which pulls the email KPIs from the
// ActiveCampaign MCP and the partner deal figures from public.ac_indirect_deals,
// then INSERTs one row per Australian FY per run. Here we just return the LATEST
// row per FY — no source calls at request time.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { getIndirectDeals } from './indirect-deals.js';

const SRC =
  'Live (Supabase cache email_partner_metrics, refreshed weekly): email KPIs from ' +
  'ActiveCampaign (run_campaign_performance_report + list_contacts/list_lists); ' +
  'partner enquiries/bookings/revenue from ac_indirect_deals. Replies and send-cadence ' +
  'are not tracked in ActiveCampaign.';

// Latest snapshot row per FY (most recent captured_at wins).
const LATEST_SQL = `
  SELECT DISTINCT ON (fy_end)
    fy_end, fy_label, window_start, window_end, captured_at,
    campaigns_sent, total_sends, open_rate, click_rate, click_to_open_rate,
    unsubscribe_rate, total_unsubscribes, bounce_rate, total_bounces,
    total_unique_opens, total_unique_clicks,
    active_contacts, bureau_list_subscribers,
    bureau_enquiries, bureau_bookings, bureau_revenue, bureau_contacts,
    tailor_enquiries, tailor_bookings, tailor_revenue, tailor_contacts
  FROM public.email_partner_metrics
  ORDER BY fy_end, captured_at DESC`;

export async function getEmailPartnerMetrics() {
  if (!supabaseConfigured()) {
    return {
      data: [], defaultFy: null, capturedAt: null, deals: [],
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' },
    };
  }
  const [rows, dealsRes] = await Promise.all([
    q(LATEST_SQL),
    getIndirectDeals().catch(() => ({ deals: [] })),
  ]);
  const n = (v) => (v == null ? null : Number(v));
  const data = rows.map((r) => ({
    fyEnd: n(r.fy_end),
    fyLabel: r.fy_label,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    capturedAt: r.captured_at,
    email: {
      campaignsSent: n(r.campaigns_sent),
      totalSends: n(r.total_sends),
      openRate: n(r.open_rate),
      clickRate: n(r.click_rate),
      clickToOpenRate: n(r.click_to_open_rate),
      unsubscribeRate: n(r.unsubscribe_rate),
      totalUnsubscribes: n(r.total_unsubscribes),
      bounceRate: n(r.bounce_rate),
      totalBounces: n(r.total_bounces),
      totalUniqueOpens: n(r.total_unique_opens),
      totalUniqueClicks: n(r.total_unique_clicks),
    },
    subscribers: {
      activeContacts: n(r.active_contacts),
      bureauListSubscribers: n(r.bureau_list_subscribers),
    },
    partners: {
      bureau: {
        enquiries: n(r.bureau_enquiries),
        bookings: n(r.bureau_bookings),
        revenue: n(r.bureau_revenue),
        contacts: n(r.bureau_list_subscribers), // outreach audience = SPEAKERS BUREAUS list
      },
      tailor: {
        enquiries: n(r.tailor_enquiries),
        bookings: n(r.tailor_bookings),
        revenue: n(r.tailor_revenue),
        contacts: n(r.tailor_contacts),
      },
    },
  }));

  // Default FY = highest FY present (current year).
  const defaultFy = data.length ? `fy${String(Math.max(...data.map((d) => d.fyEnd))).slice(-2)}` : null;
  const capturedAt = data.reduce((mx, d) => (d.capturedAt > mx ? d.capturedAt : mx), null);

  return {
    data,
    defaultFy,
    capturedAt,
    deals: (dealsRes && dealsRes.deals) || [],
    meta: {
      status: data.length ? 'live' : 'pending',
      source: SRC,
      note: data.length ? null : 'No snapshots yet — run the email-partners-sync routine.',
    },
  };
}
