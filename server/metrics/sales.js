// Sales metrics — composed from Supabase (activecampaign_deals, leads,
// follow_up_sequence_logs, ac_custom_fields). Values in activecampaign_deals are
// in CENTS and currency case is mixed, so we divide by 100 and lower(currency).

import { q, supabaseConfigured } from '../providers/supabase.js';
import { monthWindow, fillMonths, pctChange } from '../lib/range.js';
import { live, pending, section } from '../lib/metric.js';
import { SOURCE_BUCKET } from '../lib/sql.js';

const SB = 'Supabase';

export async function getSales(range) {
  if (!supabaseConfigured()) return notConfigured(range);

  const { startDate, months } = monthWindow(range);
  const monthsBack = months.length;

  const [windowAgg, priorAgg, pipeline, trendRows, sourceRows, outboundRows, demoRows, leadRows] =
    await Promise.all([
      // KPIs for the selected window (by deal creation date)
      q(
        `SELECT count(*) AS created,
                count(*) FILTER (WHERE status=1) AS won,
                count(*) FILTER (WHERE status=2) AS lost,
                round(coalesce(sum(value) FILTER (WHERE status=1 AND lower(currency)='aud'),0)/100.0,0) AS won_value,
                round(coalesce(avg(value) FILTER (WHERE status=1 AND lower(currency)='aud'),0)/100.0,0) AS avg_deal
         FROM activecampaign_deals WHERE cdate >= $1`,
        [startDate]
      ),
      // Prior equal-length window, for deltas
      q(
        `SELECT count(*) AS created,
                count(*) FILTER (WHERE status=1) AS won,
                round(coalesce(sum(value) FILTER (WHERE status=1 AND lower(currency)='aud'),0)/100.0,0) AS won_value
         FROM activecampaign_deals
         WHERE cdate >= ($1::date - ($2 || ' months')::interval) AND cdate < $1::date`,
        [startDate, monthsBack]
      ),
      // Current open pipeline value (not window-limited)
      q(
        `SELECT count(*) AS open_deals,
                round(coalesce(sum(value) FILTER (WHERE lower(currency)='aud'),0)/100.0,0) AS open_value
         FROM activecampaign_deals WHERE status=0`
      ),
      // Monthly deal trend
      q(
        `SELECT to_char(date_trunc('month',cdate),'YYYY-MM') AS month,
                count(*) AS created,
                count(*) FILTER (WHERE status=1) AS won,
                count(*) FILTER (WHERE status=2) AS lost,
                round(coalesce(sum(value) FILTER (WHERE status=1 AND lower(currency)='aud'),0)/100.0,0) AS revenue
         FROM activecampaign_deals WHERE cdate >= $1 GROUP BY 1`,
        [startDate]
      ),
      // Lead-source breakdown within the window (conversions per source)
      q(
        `SELECT bucket AS source, count(*) AS deals,
                count(*) FILTER (WHERE status=1) AS won
         FROM (
           SELECT status, ${SOURCE_BUCKET} AS bucket
           FROM (SELECT status, lower(trim(split_part(title,'//',2))) AS s
                 FROM activecampaign_deals WHERE cdate >= $1) t
         ) b GROUP BY bucket ORDER BY deals DESC`,
        [startDate]
      ),
      // Outbound sends per ISO week (last 12 weeks). follow_up_sequence_logs only
      // has (id, created_at, lead_type, message_no) — no per-person identifier —
      // so "people reached" isn't derivable from this table; sends is the real signal.
      q(
        `SELECT to_char(date_trunc('week',created_at),'YYYY-MM-DD') AS week, count(*) AS sends
         FROM follow_up_sequence_logs
         WHERE created_at >= (CURRENT_DATE - INTERVAL '12 weeks') GROUP BY 1 ORDER BY 1`
      ),
      // Demos delivered per month (ac_custom_fields.demo_date)
      q(
        `SELECT to_char(date_trunc('month',demo_date),'YYYY-MM') AS month, count(*) AS demos
         FROM ac_custom_fields WHERE demo_date IS NOT NULL AND demo_date >= $1 GROUP BY 1`,
        [startDate]
      ),
      // Inbound inquiries (leads) per month + referred split
      q(
        `SELECT to_char(date_trunc('month',created_at),'YYYY-MM') AS month,
                count(*) AS leads,
                count(*) FILTER (WHERE is_referred) AS referred
         FROM leads WHERE created_at >= $1 GROUP BY 1`,
        [startDate]
      ),
    ]);

  const w = windowAgg[0], p = priorAgg[0], pipe = pipeline[0];
  const winRate = Number(w.won) + Number(w.created) ? Math.round((Number(w.won) / Number(w.created)) * 100) : 0;

  const trend = fillMonths(months, trendRows, 'month', ['created', 'won', 'lost', 'revenue']);
  const leadTrend = fillMonths(months, leadRows, 'month', ['leads', 'referred']);
  const demoTrend = fillMonths(months, demoRows, 'month', ['demos']);

  const referredTotal = leadTrend.reduce((a, r) => a + r.referred, 0);
  const leadsTotal = leadTrend.reduce((a, r) => a + r.leads, 0);
  const directTotal = leadsTotal - referredTotal;

  return {
    range,
    asOf: new Date().toISOString(),
    kpis: {
      created: live(Number(w.created), 'count', { source: SB, delta: pctChange(+w.created, +p.created), note: 'Deals created in period' }),
      won: live(Number(w.won), 'count', { source: SB, delta: pctChange(+w.won, +p.won) }),
      winRate: live(winRate, 'percent', { source: SB, note: 'Won ÷ created in period' }),
      wonValue: live(Number(w.won_value), 'currency', { source: SB, delta: pctChange(+w.won_value, +p.won_value), note: 'Contracted (CRM) value' }),
      avgDeal: live(Number(w.avg_deal), 'currency', { source: SB }),
      openPipeline: live(Number(pipe.open_value), 'currency', { source: SB, note: `${pipe.open_deals} open deals (current)` }),
    },
    trend: section(trend, { source: SB }),
    sources: section(sourceRows.map((r) => ({
      source: r.source, deals: Number(r.deals), won: Number(r.won),
      winRate: Number(r.deals) ? Math.round((Number(r.won) / Number(r.deals)) * 100) : 0,
    })), { source: SB, note: 'Source inferred from deal-title taxonomy' }),
    leadsTrend: section(leadTrend, { source: SB, note: 'From leads intake table' }),
    directIndirect: section(
      [{ label: 'Direct', value: directTotal }, { label: 'Indirect / referred', value: referredTotal }],
      { source: SB, note: 'From leads.is_referred (bureau not explicitly tagged)' }
    ),
    outbound: section(outboundRows.map((r) => ({ week: r.week, sends: Number(r.sends) })),
      { source: SB, note: 'follow_up_sequence_logs — message sends per week (per-person tracking not available in this table)' }),
    demos: section(demoTrend, { source: SB, note: 'Delivered demos (ac_custom_fields.demo_date)' }),
    // Flagged gaps (needs setup)
    googleAds: pending('count', { note: 'No Google Ads attribution in any source yet. Populate AC "Lead Source" = Google Ads, or connect the Google Ads API.' }),
    replies: pending('count', { note: 'Replies are not captured in Supabase (replied = 0). Needs Gmail/AC reply tracking.' }),
  };
}

function notConfigured(range) {
  const p = () => pending('count', { source: SB, note: 'Supabase not configured (set SUPABASE_DB_URL).' });
  return {
    range, asOf: new Date().toISOString(),
    kpis: { created: p(), won: p(), winRate: p(), wonValue: p(), avgDeal: p(), openPipeline: p() },
    trend: section([], { source: SB, status: 'pending', note: 'Supabase not configured.' }),
    sources: section([], { source: SB, status: 'pending' }),
    leadsTrend: section([], { source: SB, status: 'pending' }),
    directIndirect: section([], { source: SB, status: 'pending' }),
    outbound: section([], { source: SB, status: 'pending' }),
    demos: section([], { source: SB, status: 'pending' }),
    googleAds: pending('count', { note: 'Needs Google Ads attribution.' }),
    replies: pending('count', { note: 'Needs reply tracking.' }),
  };
}
