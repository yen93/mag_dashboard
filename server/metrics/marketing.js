// Marketing metrics — Supabase-backed (leads, google_reviews, deals) now; the
// Calendly / ActiveCampaign / Xero pieces come online as those credentials land.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { monthWindow, fillMonths, pctChange } from '../lib/range.js';
import { live, pending, section } from '../lib/metric.js';
import { SOURCE_BUCKET, LEAD_SOURCE_LABEL } from '../lib/sql.js';

const SB = 'Supabase';

export async function getMarketing(range) {
  if (!supabaseConfigured()) return notConfigured(range);

  const { startDate, months } = monthWindow(range);
  const monthsBack = months.length;

  const [thisMonth, prevMonth, reviewsRows, leadsBySource, leadsTrendRows, wonByBucket] = await Promise.all([
    // "This month" KPI counts
    q(`SELECT
         (SELECT count(*) FROM leads WHERE date_trunc('month',created_at)=date_trunc('month',CURRENT_DATE)) AS leads,
         (SELECT count(*) FROM google_reviews WHERE date_trunc('month',review_create_time)=date_trunc('month',CURRENT_DATE)) AS reviews,
         (SELECT count(*) FROM ac_custom_fields WHERE date_trunc('month',demo_date)=date_trunc('month',CURRENT_DATE)) AS demos`),
    // Previous month, for deltas
    q(`SELECT
         (SELECT count(*) FROM leads WHERE date_trunc('month',created_at)=date_trunc('month',CURRENT_DATE - INTERVAL '1 month')) AS leads,
         (SELECT count(*) FROM google_reviews WHERE date_trunc('month',review_create_time)=date_trunc('month',CURRENT_DATE - INTERVAL '1 month')) AS reviews`),
    // Google reviews per month + avg rating over the window
    q(`SELECT to_char(date_trunc('month',review_create_time),'YYYY-MM') AS month,
              count(*) AS reviews,
              round(avg(NULLIF(star_rating,'')::numeric),2) AS avg_stars
       FROM google_reviews WHERE review_create_time >= $1 GROUP BY 1`, [startDate]),
    // New leads by source (window) — partial; full split needs AC Lead Source
    q(`SELECT coalesce(source_table,'unknown') AS source, count(*) AS n
       FROM leads WHERE created_at >= $1 GROUP BY 1 ORDER BY n DESC`, [startDate]),
    // Leads trend
    q(`SELECT to_char(date_trunc('month',created_at),'YYYY-MM') AS month, count(*) AS leads
       FROM leads WHERE created_at >= $1 GROUP BY 1`, [startDate]),
    // Keynotes / offsites (Immersive) booked (won) with contracted value, window
    q(`SELECT bucket, count(*) FILTER (WHERE status=1) AS won,
              round(coalesce(sum(value) FILTER (WHERE status=1 AND lower(currency)='aud'),0)/100.0,0) AS won_value
       FROM (SELECT status, value, currency, ${SOURCE_BUCKET} AS bucket
             FROM (SELECT status, value, currency, lower(trim(split_part(title,'//',2))) AS s
                   FROM activecampaign_deals WHERE cdate >= $1) t) b
       GROUP BY bucket`, [startDate]),
  ]);

  const tm = thisMonth[0], pm = prevMonth[0];
  const reviewsTrend = fillMonths(months, reviewsRows.map((r) => ({ ...r, avg_stars: r.avg_stars })), 'month', ['reviews']);
  // attach avg_stars separately (fillMonths only carries numeric value fields)
  const starsByMonth = new Map(reviewsRows.map((r) => [r.month, Number(r.avg_stars)]));
  reviewsTrend.forEach((r) => { r.avgStars = starsByMonth.get(r.month) || null; });

  const leadsTrend = fillMonths(months, leadsTrendRows, 'month', ['leads']);
  const bucketMap = new Map(wonByBucket.map((r) => [r.bucket, r]));
  const keynote = bucketMap.get('Keynote') || { won: 0, won_value: 0 };
  const offsite = bucketMap.get('Immersive') || { won: 0, won_value: 0 };

  return {
    range,
    asOf: new Date().toISOString(),
    kpis: {
      newLeads: live(Number(tm.leads), 'count', { source: SB, delta: pctChange(+tm.leads, +pm.leads), note: 'Leads created this month' }),
      reviews: live(Number(tm.reviews), 'count', { source: SB, delta: pctChange(+tm.reviews, +pm.reviews), note: 'New Google reviews this month' }),
      demosBooked: live(Number(tm.demos), 'count', { source: SB, note: 'Delivered demos this month (Calendly booking feed pending)' }),
      keynotes: live(Number(keynote.won), 'count', { source: SB, note: `Keynotes won in period · A$${Number(keynote.won_value).toLocaleString()} contracted` }),
    },
    reviewsTrend: section(reviewsTrend, { source: SB, note: 'google_reviews (2017→present)' }),
    leadsBySource: section(
      leadsBySource.map((r) => ({ source: LEAD_SOURCE_LABEL[r.source] || r.source, value: Number(r.n) })),
      { source: SB, status: 'partial', note: 'Outbound sources only. Full split (Google Ads/Bing/Organic/Direct/Bureau/Referral…) needs the AC "Lead Source" field populated.' }
    ),
    leadsTrend: section(leadsTrend, { source: SB }),
    bookings: section([
      { type: 'Keynotes', count: Number(keynote.won), value: Number(keynote.won_value) },
      { type: 'Offsites / Immersive', count: Number(offsite.won), value: Number(offsite.won_value) },
    ], { source: SB, note: 'Counts + CRM-contracted value. Billed value needs Xero.' }),
    // Pending (need other sources)
    emailRates: pending('percent', { source: 'ActiveCampaign', note: 'Open / click / unsubscribe rates come from the ActiveCampaign API (credential pending).' }),
    keynoteToOffsite: pending('percent', { note: 'Keynote→offsite conversion needs keynote clients consistently flagged (AC "Sent Post Keynote Invite").' }),
    demoCallsBooked: pending('count', { source: 'Calendly', note: 'Booked demo calls come from Calendly (authorization pending).' }),
  };
}

function notConfigured(range) {
  const p = () => pending('count', { source: SB, note: 'Supabase not configured (set SUPABASE_DB_URL).' });
  return {
    range, asOf: new Date().toISOString(),
    kpis: { newLeads: p(), reviews: p(), demosBooked: p(), keynotes: p() },
    reviewsTrend: section([], { source: SB, status: 'pending' }),
    leadsBySource: section([], { source: SB, status: 'pending' }),
    leadsTrend: section([], { source: SB, status: 'pending' }),
    bookings: section([], { source: SB, status: 'pending' }),
    emailRates: pending('percent', { source: 'ActiveCampaign', note: 'Pending.' }),
    keynoteToOffsite: pending('percent', { note: 'Pending.' }),
    demoCallsBooked: pending('count', { source: 'Calendly', note: 'Pending.' }),
  };
}
