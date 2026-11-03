// Ad Platforms — raw per-platform performance straight from each source's sync.
//
// Backs the Marketing "Ad Platforms" tab (public/ad_platforms.html). ONE endpoint,
// three datasets the page toggles between client-side (all small, so we return them
// together and switch instantly with no refetch):
//   • ga4    — GA4 website events (public.ga4_events_staging): events by date / source /
//              medium / campaign / page. Rolling ~60-day window (the staging table is
//              truncate-reloaded from GA4 by the GA4 events sync).
//   • google — Google Ads campaign performance, monthly (public.google_ads_campaign_monthly),
//              straight from the Google Ads API via the google-ads-campaign-monthly-sync
//              edge function. (This is the PLATFORM figure — distinct from the Xero-billed
//              google_ads_xero_monthly the ROAS tab uses for cost.)
//   • bing   — Microsoft/Bing Ads campaign performance, monthly
//              (public.bing_ads_campaign_monthly_raw), straight from the Microsoft
//              Advertising Reporting API via the standalone bing-ads-campaign-monthly-sync.
//
// Plain single-table SELECTs, no joins at request time → a short cache is plenty. Each
// source is read independently so one missing/empty table can't fail the whole endpoint.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC = {
  ga4:    'GA4 website events (public.ga4_events_staging, Supabase)',
  google: 'Google Ads API (public.google_ads_campaign_monthly, Supabase)',
  bing:   'Microsoft Advertising API (public.bing_ads_campaign_monthly_raw, Supabase)',
};

// Google Ads + Bing share an identical campaign-monthly shape, so one SQL builder serves
// both. bigint counts are cast to int and numeric money to float8 so the JSON carries real
// numbers (node-pg returns bigint/numeric as strings otherwise, which breaks sort + sums).
function campaignMonthlySql(table) {
  return `
    SELECT
      month,
      campaign_name                                             AS "campaignName",
      channel_type                                              AS "channelType",
      impressions::int                                          AS "impressions",
      clicks::int                                               AS "clicks",
      cost::float8                                              AS "cost",
      conversions::float8                                       AS "conversions",
      conversions_value::float8                                 AS "convValue",
      CASE WHEN impressions > 0 THEN round(100.0 * clicks / impressions, 2)::float8 END AS "ctr",
      CASE WHEN clicks > 0      THEN round(cost / clicks, 2)::float8 END               AS "cpc",
      CASE WHEN conversions > 0 THEN round(cost / conversions, 2)::float8 END          AS "costPerConv"
    FROM public.${table}
    ORDER BY month DESC, cost DESC`;
}

const GA4_SQL = `
  SELECT
    event_time_utc  AS "eventTime",
    event_name      AS "eventName",
    source          AS "source",
    medium          AS "medium",
    campaign        AS "campaign",
    page_path       AS "pagePath",
    event_count::int AS "eventCount"
  FROM public.ga4_events_staging
  ORDER BY event_time_utc DESC`;

// Read one source's rows, degrading to a pending section (never throwing) on error/empty
// so the tab still loads if a single table is missing or its sync hasn't run.
async function readSource(key, sql, emptyNote) {
  try {
    const rows = await q(sql);
    if (!rows.length) {
      return { rows: [], meta: { status: 'pending', source: SRC[key], note: emptyNote } };
    }
    return { rows, meta: { status: 'live', source: SRC[key], note: `${rows.length} rows.` } };
  } catch (err) {
    return { rows: [], meta: { status: 'pending', source: SRC[key], note: `Could not read source: ${err.message}` } };
  }
}

export async function getAdPlatforms() {
  if (!supabaseConfigured()) {
    const pend = (key) => ({ rows: [], meta: { status: 'pending', source: SRC[key], note: 'Supabase not configured (set SUPABASE_DB_URL).' } });
    return { asOf: new Date().toISOString(), sources: { ga4: pend('ga4'), google: pend('google'), bing: pend('bing') } };
  }

  const [ga4, google, bing] = await Promise.all([
    readSource('ga4', GA4_SQL, 'GA4 events staging is empty — it is truncate-reloaded from GA4 by the GA4 events sync.'),
    readSource('google', campaignMonthlySql('google_ads_campaign_monthly'),
      'No Google Ads rows — run / wait for the google-ads-campaign-monthly-sync edge function.'),
    readSource('bing', campaignMonthlySql('bing_ads_campaign_monthly_raw'),
      'No Bing Ads rows — run / wait for the bing-ads-campaign-monthly-sync edge function.'),
  ]);

  return { asOf: new Date().toISOString(), sources: { ga4, google, bing } };
}
