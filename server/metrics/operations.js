// Operations metrics — Supabase-backed delivery/revenue/pipeline view now; the
// Google-Sheet buyer segmentation and monday keynote-pipeline pieces come online
// with those credentials.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { monthWindow, fillMonths, pctChange } from '../lib/range.js';
import { live, pending, section } from '../lib/metric.js';
import { SOURCE_BUCKET } from '../lib/sql.js';

const SB = 'Supabase';

export async function getOperations(range) {
  if (!supabaseConfigured()) return notConfigured(range);

  const { startDate, months } = monthWindow(range);
  const monthsBack = months.length;

  const [windowAgg, priorAgg, statusAgg, revenueRows, programRows, growthRows, outboundRows, reviewRows] =
    await Promise.all([
      q(`SELECT
           round(coalesce(sum(value) FILTER (WHERE status=1 AND lower(currency)='aud'),0)/100.0,0) AS revenue,
           count(*) FILTER (WHERE status=1) AS won,
           count(*) FILTER (WHERE event_date IS NOT NULL) AS delivered
         FROM activecampaign_deals WHERE cdate >= $1`, [startDate]),
      q(`SELECT round(coalesce(sum(value) FILTER (WHERE status=1 AND lower(currency)='aud'),0)/100.0,0) AS revenue
         FROM activecampaign_deals
         WHERE cdate >= ($1::date - ($2 || ' months')::interval) AND cdate < $1::date`, [startDate, monthsBack]),
      q(`SELECT count(*) FILTER (WHERE status=0) AS open,
                count(*) FILTER (WHERE status=1) AS won,
                count(*) FILTER (WHERE status=2) AS lost,
                round(coalesce(sum(value) FILTER (WHERE status=0 AND lower(currency)='aud'),0)/100.0,0) AS open_value
         FROM activecampaign_deals`),
      // Revenue (won contracted value) by month
      q(`SELECT to_char(date_trunc('month',cdate),'YYYY-MM') AS month,
                round(coalesce(sum(value) FILTER (WHERE status=1 AND lower(currency)='aud'),0)/100.0,0) AS revenue
         FROM activecampaign_deals WHERE cdate >= $1 GROUP BY 1`, [startDate]),
      // Program mix (won deals by bucket)
      q(`SELECT bucket, count(*) FILTER (WHERE status=1) AS won
         FROM (SELECT status, ${SOURCE_BUCKET} AS bucket
               FROM (SELECT status, lower(trim(split_part(title,'//',2))) AS s
                     FROM activecampaign_deals WHERE cdate >= $1) t) b
         GROUP BY bucket HAVING count(*) FILTER (WHERE status=1) > 0 ORDER BY won DESC`, [startDate]),
      // Contacts & accounts growth
      q(`SELECT to_char(date_trunc('month',cdate),'YYYY-MM') AS month, count(*) AS contacts, 0 AS accounts
         FROM activecampaign_contacts WHERE cdate >= $1 GROUP BY 1
         UNION ALL
         SELECT to_char(date_trunc('month',"createdTimestamp"),'YYYY-MM'), 0, count(*)
         FROM activecampaign_accounts WHERE "createdTimestamp" >= $1 GROUP BY 1`, [startDate]),
      // Outbound throughput by month
      q(`SELECT to_char(date_trunc('month',created_at),'YYYY-MM') AS month, count(*) AS sends
         FROM follow_up_sequence_logs WHERE created_at >= $1 GROUP BY 1`, [startDate]),
      // Google review volume + rating
      q(`SELECT to_char(date_trunc('month',review_create_time),'YYYY-MM') AS month,
                count(*) AS reviews, round(avg(NULLIF(star_rating,'')::numeric),2) AS avg_stars
         FROM google_reviews WHERE review_create_time >= $1 GROUP BY 1`, [startDate]),
    ]);

  const w = windowAgg[0], p = priorAgg[0], st = statusAgg[0];
  const revenueTrend = fillMonths(months, revenueRows, 'month', ['revenue']);

  // Merge the two halves of the growth UNION into one month axis.
  const growthMerged = fillMonths(months, mergeByMonth(growthRows, ['contacts', 'accounts']), 'month', ['contacts', 'accounts']);
  const outboundTrend = fillMonths(months, outboundRows, 'month', ['sends']);
  const reviewTrend = fillMonths(months, reviewRows, 'month', ['reviews']);
  const starsByMonth = new Map(reviewRows.map((r) => [r.month, Number(r.avg_stars)]));
  reviewTrend.forEach((r) => { r.avgStars = starsByMonth.get(r.month) || null; });

  const avgRatingOverall = reviewRows.length
    ? Math.round((reviewRows.reduce((a, r) => a + Number(r.avg_stars || 0) * Number(r.reviews), 0) /
        reviewRows.reduce((a, r) => a + Number(r.reviews), 0)) * 100) / 100
    : null;

  return {
    range,
    asOf: new Date().toISOString(),
    kpis: {
      revenue: live(Number(w.revenue), 'currency', { source: SB, delta: pctChange(+w.revenue, +p.revenue), note: 'Won (contracted) value in period' }),
      delivered: live(Number(w.delivered), 'count', { source: SB, note: 'Deals with a delivery/event date' }),
      openPipeline: live(Number(st.open_value), 'currency', { source: SB, note: `${st.open} open deals` }),
      avgRating: live(avgRatingOverall ?? 0, 'rating', { source: SB, note: 'Avg Google review stars in period' }),
    },
    revenueTrend: section(revenueTrend, { source: SB }),
    programMix: section(programRows.map((r) => ({ label: r.bucket, value: Number(r.won) })), { source: SB, note: 'Won deals by program/source bucket' }),
    pipeline: section([
      { label: 'Open', value: Number(st.open) },
      { label: 'Won', value: Number(st.won) },
      { label: 'Lost', value: Number(st.lost) },
    ], { source: SB, note: 'Current all-time pipeline snapshot (not limited to the selected period)' }),
    growth: section(growthMerged, { source: SB, note: 'New contacts & accounts per month' }),
    outbound: section(outboundTrend, { source: SB, note: 'follow_up_sequence_logs' }),
    reviews: section(reviewTrend, { source: SB }),
    // Pending (need other sources)
    buyerSegmentation: pending('count', { source: 'Google Sheet', note: 'Industry / business-size / seniority segmentation comes from the MAG Buyer Analysis sheet (credential pending).' }),
    keynotePipeline: pending('count', { source: 'monday.com', note: 'Keynote delivery phase (Phase 1/2/3/Completed) comes from the monday Keynote Management boards (credential pending).' }),
  };
}

// Collapse a UNION-ALL result (each row contributes one field) into one row per month.
function mergeByMonth(rows, fields) {
  const map = new Map();
  for (const r of rows) {
    const cur = map.get(r.month) || { month: r.month, ...Object.fromEntries(fields.map((f) => [f, 0])) };
    for (const f of fields) cur[f] += Number(r[f] || 0);
    map.set(r.month, cur);
  }
  return [...map.values()];
}

function notConfigured(range) {
  const p = () => pending('currency', { source: SB, note: 'Supabase not configured (set SUPABASE_DB_URL).' });
  return {
    range, asOf: new Date().toISOString(),
    kpis: { revenue: p(), delivered: p(), openPipeline: p(), avgRating: p() },
    revenueTrend: section([], { source: SB, status: 'pending' }),
    programMix: section([], { source: SB, status: 'pending' }),
    pipeline: section([], { source: SB, status: 'pending' }),
    growth: section([], { source: SB, status: 'pending' }),
    outbound: section([], { source: SB, status: 'pending' }),
    reviews: section([], { source: SB, status: 'pending' }),
    buyerSegmentation: pending('count', { source: 'Google Sheet', note: 'Pending.' }),
    keynotePipeline: pending('count', { source: 'monday.com', note: 'Pending.' }),
  };
}
