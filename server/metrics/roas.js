// ROAS (Return on Ad Spend) — Google Ads performance, year on year (calendar year).
//
// LIVE, computed at request time from TWO Supabase tables (no cache table, no
// external source call — both tables are in the same DB, so a plain aggregation
// query is fast and always fresh):
//   • public.google_ads_campaign_monthly — monthly Google Ads cost per campaign
//     (the ad-spend DENOMINATOR). Refreshed by the google-ads-campaign-monthly-sync
//     routine. Coverage starts Jul 2024, so the tab shows only years with ad spend.
//   • public.ga4_ac_contact_source — per-contact GA4/Calendly→AC attribution (the
//     NUMERATOR: won/lost/open deals + values). "Google Ads" = the CRM "Google
//     Ads?" field = Yes OR the GA4 session channel = google / cpc.
//
// NOTE — this is a LIVE, GA4-attributed ROAS, NOT the audited "MAG Marketing ROAS
// Report" sheet. It uses CRM deal_value (not ex-GST Buyer Analysis values) and a
// broader "Google Ads?" population, so the numbers differ from that report by
// design. Revenue is counted in the year the ENQUIRY came in (contact cdate →
// cal_yr), which matches the report's timing basis. A year whose ad spend covers
// fewer than 12 months (e.g. 2024 = Jul–Dec only) will read high — the per-row
// note says how many months of spend it has.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'Live: ga4_ac_contact_source × google_ads_campaign_monthly (Supabase)';
const TARGET_ROAS = 2;

// "Google Ads" attribution filter — kept in one place so it's easy to tune.
const GADS_FILTER = `(cs.google_ads_ac_field = 'Yes' OR cs.channel = 'google / cpc')`;

const SELECT = `
  WITH deals AS (
    SELECT
      cs.cal_yr                                                         AS cal_yr,
      count(*) FILTER (WHERE cs.deal_status = 'won')                    AS won_leads,
      count(*) FILTER (WHERE cs.deal_status = 'lost')                   AS lost_leads,
      count(*) FILTER (WHERE cs.deal_status = 'open')                   AS open_leads,
      count(*) FILTER (WHERE cs.deal_status IN ('won','lost','open'))   AS leads,
      coalesce(sum(cs.deal_value) FILTER (WHERE cs.deal_status = 'won'),  0) AS won_amount,
      coalesce(sum(cs.deal_value) FILTER (WHERE cs.deal_status = 'lost'), 0) AS lost_amount,
      coalesce(sum(cs.deal_value) FILTER (WHERE cs.deal_status = 'open'), 0) AS open_amount
    FROM public.ga4_ac_contact_source cs
    WHERE cs.cal_yr IS NOT NULL
      AND cs.deal_status IN ('won','lost','open')
      AND ${GADS_FILTER}
    GROUP BY cs.cal_yr
  ),
  spend AS (
    SELECT
      extract(year FROM month)::int  AS cal_yr,
      coalesce(round(sum(cost)), 0)  AS ad_spend,
      count(DISTINCT month)          AS spend_months,
      to_char(min(month), 'Mon')     AS first_spend_month,
      to_char(max(month), 'Mon YYYY') AS last_spend_month
    FROM public.google_ads_campaign_monthly
    GROUP BY 1
  )
  SELECT
    coalesce(d.cal_yr, s.cal_yr)      AS "year",
    coalesce(d.won_leads, 0)          AS "wonLeads",
    coalesce(d.lost_leads, 0)         AS "lostLeads",
    coalesce(d.open_leads, 0)         AS "openLeads",
    coalesce(d.leads, 0)              AS "leads",
    coalesce(d.won_amount, 0)         AS "wonAmount",
    coalesce(d.lost_amount, 0)        AS "lostAmount",
    coalesce(d.open_amount, 0)        AS "openAmount",
    s.ad_spend                        AS "adSpend",
    s.spend_months                    AS "spendMonths",
    s.first_spend_month               AS "firstSpendMonth",
    s.last_spend_month                AS "lastSpendMonth"
  FROM spend s
  LEFT JOIN deals d ON d.cal_yr = s.cal_yr
  WHERE s.ad_spend > 0           -- only years with ad spend (ROAS needs a denominator)
  ORDER BY s.cal_yr`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

// Derive the per-row ratios + labels the page shows. won_amount == won_revenue
// here (won deal value credited to Google Ads); both columns are populated.
function shape(r) {
  const year = num(r.year);
  const leads = num(r.leads) || 0;
  const wonAmount = num(r.wonAmount) || 0;
  const adSpend = num(r.adSpend) || 0;
  const spendMonths = num(r.spendMonths) || 0;
  const roiDollars = wonAmount - adSpend;
  const partial = spendMonths > 0 && spendMonths < 12;
  const periodLabel = partial
    ? `${year} · ${spendMonths} mo ad spend`
    : `Jan–Dec ${year}`;
  const countedMethod =
    `Live GA4-attributed Google Ads deals (CRM "Google Ads?"=Yes or google/cpc), ` +
    `by enquiry date, ÷ Google Ads spend (${spendMonths} mo` +
    (r.firstSpendMonth && r.lastSpendMonth ? `, ${r.firstSpendMonth}–${r.lastSpendMonth}` : '') + ').';
  return {
    year,
    periodLabel,
    wonLeads: num(r.wonLeads) || 0,
    lostLeads: num(r.lostLeads) || 0,
    openLeads: num(r.openLeads) || 0,
    leads,
    wonAmount,
    lostAmount: num(r.lostAmount) || 0,
    openAmount: num(r.openAmount) || 0,
    winRate: leads ? (num(r.wonLeads) || 0) / leads : null,
    adSpend,
    wonRevenue: wonAmount,
    roiDollars,
    roiPct: adSpend ? roiDollars / adSpend : null,
    roas: adSpend ? wonAmount / adSpend : null,
    perLeadValue: leads ? wonAmount / leads : null,
    spendMonths,
    countedMethod,
    targetRoas: TARGET_ROAS,
  };
}

// "All years" total — summed; ratios recomputed, not summed.
function totalRow(rows) {
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const wonAmount = sum('wonAmount');
  const leads = sum('leads');
  const adSpend = sum('adSpend');
  const roiDollars = wonAmount - adSpend;
  return {
    year: null,
    periodLabel: 'All years',
    label: 'All years',
    wonAmount,
    lostAmount: sum('lostAmount'),
    openAmount: sum('openAmount'),
    wonLeads: sum('wonLeads'),
    lostLeads: sum('lostLeads'),
    openLeads: sum('openLeads'),
    leads,
    winRate: leads ? sum('wonLeads') / leads : null,
    adSpend,
    wonRevenue: wonAmount,
    roiDollars,
    roiPct: adSpend ? roiDollars / adSpend : null,
    roas: adSpend ? wonAmount / adSpend : null,
    perLeadValue: leads ? wonAmount / leads : null,
    countedMethod: '',
    targetRoas: TARGET_ROAS,
  };
}

export async function getRoas() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      target: TARGET_ROAS,
      total: null,
      rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
    };
  }

  const rows = (await q(SELECT)).map(shape);

  if (!rows.length) {
    return {
      asOf: new Date().toISOString(),
      target: TARGET_ROAS,
      total: null,
      rows: section([], {
        source: SRC,
        status: 'pending',
        note: 'No Google Ads spend found in public.google_ads_campaign_monthly — populate it (google-ads-campaign-monthly-sync) to show ROAS.',
      }),
    };
  }

  const total = totalRow(rows);
  const note =
    `${rows.length} year(s) with ad spend (${rows[0].year}–${rows[rows.length - 1].year}). ` +
    `Live GA4-attributed: all-years ROAS ${total.roas.toFixed(2)}× vs ${TARGET_ROAS.toFixed(2)}× target. ` +
    `Not the audited ROAS report (CRM deal values, broader Google Ads? population).`;

  return {
    asOf: new Date().toISOString(),
    target: TARGET_ROAS,
    total,
    rows: section(rows, { source: SRC, status: 'live', note }),
  };
}
