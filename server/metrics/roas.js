// ROAS (Return on Ad Spend) — Google Ads performance, year on year (calendar year).
//
// LIVE, computed at request time from TWO Supabase tables (no cache table, no
// external source call — both tables are in the same DB, so a plain aggregation
// query is fast and always fresh):
//   • public.google_ads_campaign_monthly — monthly Google Ads cost per campaign
//     (the ad-spend DENOMINATOR). Refreshed by the google-ads-campaign-monthly-sync
//     routine. Coverage starts Jul 2024, so the tab shows only years with ad spend.
//   • public.ga4_ac_contact_source — per-contact GA4/Calendly→AC attribution (the
//     WON numerator: won deals + values only). Counted population = organic/cpc channel
//     OR an EFFECTIVE JC tag (free-gift / excluded-link rows dropped). See
//     CONTACT_SOURCE_SHOWN in ../lib/sql.js — it joins the JC manual-review override
//     (public.ga4cs_jc_manual_review), so a row JC tags "Could be SEO or Paid Ad" (even
//     a "Google Ads?"=Yes row with no channel) now FEEDS ROAS, and one he reviews as
//     "Not paid ad / SEO" does not. NB: google_ads_ac_field itself is still NOT used —
//     an UNtagged "Google Ads?"=Yes row with no channel stays excluded here.
//   • public.ac_google_ads_deals — the LOST/OPEN side. As of 2026-10-21 the Lost /
//     Open COUNT columns AND the win-rate denominator come from ONLY the deals flagged
//     "Google Ads? = Yes" in AC (status_raw=2 lost / status_raw=0 open, by
//     mag_cal_yr(deal_cdate)) — NOT every CRM deal, and NOT the GA4-shown rows.
//     ASYMMETRY BY DESIGN: Won $/count = GA4-attributed shown rows; Lost/Open counts +
//     win rate = Google-Ads?=Yes deals. The "Won Leads" column shows won ÷ (won + lost +
//     open count) — same denominator as the win rate %.
//     Per-Lead Value alone still uses the GA4-shown leads basis (see shownLeads).
//     (lostAmount/openAmount are still computed in the payload but no longer displayed.)
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
import { CONTACT_SOURCE_SHOWN } from '../lib/sql.js';

const SRC = 'Live: ga4_ac_contact_source (won) + ac_google_ads_deals (lost/open, Google Ads?=Yes) × google_ads_campaign_monthly (Supabase)';
const TARGET_ROAS = 2;

// Numerator population = EXACTLY the rows shown on the GA4 & Ads Leads page
// (organic/cpc channel OR a JC manual tag; free-gift / excluded-link rows dropped).
// See CONTACT_SOURCE_SHOWN in ../lib/sql.js — google_ads_ac_field is NOT used.
const GADS_FILTER = CONTACT_SOURCE_SHOWN;

const SELECT = `
  WITH deals AS (
    -- WON side (+ the GA4-shown leads basis for Per-Lead Value / "won / N"):
    -- EXACTLY the rows shown on the GA4 & Ads Leads page.
    SELECT
      cs.cal_yr                                                         AS cal_yr,
      count(*) FILTER (WHERE cs.deal_status = 'won')                    AS won_leads,
      count(*) FILTER (WHERE cs.deal_status IN ('won','lost','open'))   AS leads,
      coalesce(sum(cs.deal_value) FILTER (WHERE cs.deal_status = 'won'),  0) AS won_amount
    FROM public.ga4_ac_contact_source cs
    -- Override join required by CONTACT_SOURCE_SHOWN: a JC manual-review decision
    -- (ga4cs_jc_manual_review) wins over cs.jc_manual_tag, so a JC-tagged
    -- "Could be SEO or Paid Ad" row feeds ROAS (and a "Not paid ad / SEO" one doesn't).
    LEFT JOIN public.ga4cs_jc_manual_review r ON r.contact_id = cs.contact_id
    WHERE cs.cal_yr IS NOT NULL
      AND cs.deal_status IN ('won','lost','open')
      AND ${GADS_FILTER}
      -- Uniting deals are referrals, not Google Ads leads — excluded from ROAS entirely
      -- (anchored, so the company is the first deal_title token; "ICMI // … // Uniting"
      -- is an ICMI deal and is NOT matched). KEEP IN SYNC with the alldeals CTE below
      -- and isExcludedRow() on the GA4 Leads page.
      AND lower(coalesce(cs.deal_title, '')) NOT LIKE 'uniting%'
    GROUP BY cs.cal_yr
  ),
  alldeals AS (
    -- LOST/OPEN side: ONLY deals flagged "Google Ads? = Yes" in AC
    -- (public.ac_google_ads_deals = the full dealCustomFieldData scan). status_raw
    -- 0=open / 2=lost, bucketed by mag_cal_yr(deal_cdate) to match
    -- ga4_ac_contact_source.cal_yr. value is already AUD here (no /100).
    SELECT
      public.mag_cal_yr(deal_cdate)                             AS cal_yr,
      count(*) FILTER (WHERE status_raw = 0)                    AS open_leads,
      count(*) FILTER (WHERE status_raw = 2)                    AS lost_leads,
      coalesce(sum(value) FILTER (WHERE status_raw = 0), 0)     AS open_amount,
      coalesce(sum(value) FILTER (WHERE status_raw = 2), 0)     AS lost_amount
    FROM public.ac_google_ads_deals
    WHERE status_raw IN (0, 2)
      -- Uniting deals are referrals — excluded from the lost/open + win-rate denominator
      -- too (see the deals CTE above). Anchored 'uniting%' on the deal title.
      AND lower(coalesce(title, '')) NOT LIKE 'uniting%'
    GROUP BY 1
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
    s.cal_yr                          AS "year",
    coalesce(d.won_leads, 0)          AS "wonLeads",
    coalesce(a.lost_leads, 0)         AS "lostLeads",
    coalesce(a.open_leads, 0)         AS "openLeads",
    coalesce(d.leads, 0)              AS "shownLeads",
    coalesce(d.won_amount, 0)         AS "wonAmount",
    coalesce(a.lost_amount, 0)        AS "lostAmount",
    coalesce(a.open_amount, 0)        AS "openAmount",
    s.ad_spend                        AS "adSpend",
    s.spend_months                    AS "spendMonths",
    s.first_spend_month               AS "firstSpendMonth",
    s.last_spend_month                AS "lastSpendMonth"
  FROM spend s
  LEFT JOIN deals d    ON d.cal_yr = s.cal_yr
  LEFT JOIN alldeals a ON a.cal_yr = s.cal_yr
  WHERE s.ad_spend > 0           -- only years with ad spend (ROAS needs a denominator)
  ORDER BY s.cal_yr`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

// Derive the per-row ratios + labels the page shows. won_amount == won_revenue
// here (won deal value credited to Google Ads); both columns are populated.
function shape(r) {
  const year = num(r.year);
  // shownLeads = GA4-shown won+lost+open — drives Per-Lead Value and the "won / N"
  // column (kept on the shown basis). The win rate uses a DIFFERENT denominator below.
  const leads = num(r.shownLeads) || 0;
  const wonLeads = num(r.wonLeads) || 0;
  const lostLeads = num(r.lostLeads) || 0;   // Google-Ads?=Yes lost deals that year
  const openLeads = num(r.openLeads) || 0;   // Google-Ads?=Yes open deals that year
  const wonAmount = num(r.wonAmount) || 0;
  const adSpend = num(r.adSpend) || 0;
  const spendMonths = num(r.spendMonths) || 0;
  const roiDollars = wonAmount - adSpend;
  const winRateLeads = wonLeads + lostLeads + openLeads; // won(shown) + Google-Ads?=Yes lost + open
  const partial = spendMonths > 0 && spendMonths < 12;
  const periodLabel = partial
    ? `${year} · ${spendMonths} mo ad spend`
    : `Jan–Dec ${year}`;
  const countedMethod =
    `Won revenue/leads shown on the GA4 & Ads page (organic/cpc channel or JC manual tag), ` +
    `by enquiry date, ÷ Google Ads spend (${spendMonths} mo` +
    (r.firstSpendMonth && r.lastSpendMonth ? `, ${r.firstSpendMonth}–${r.lastSpendMonth}` : '') + '). ' +
    `Lost/Open counts + win rate = lost/open deals flagged Google Ads?=Yes in AC (created that year).`;
  return {
    year,
    periodLabel,
    wonLeads,
    lostLeads,
    openLeads,
    leads,
    wonAmount,
    lostAmount: num(r.lostAmount) || 0,
    openAmount: num(r.openAmount) || 0,
    winRate: winRateLeads ? wonLeads / winRateLeads : null,
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
  const leads = sum('leads');                         // shownLeads total (Per-Lead Value / "won / N")
  const wonLeads = sum('wonLeads');
  const winRateLeads = wonLeads + sum('lostLeads') + sum('openLeads'); // won + Google-Ads?=Yes lost + open
  const adSpend = sum('adSpend');
  const roiDollars = wonAmount - adSpend;
  return {
    year: null,
    periodLabel: 'All years',
    label: 'All years',
    wonAmount,
    lostAmount: sum('lostAmount'),
    openAmount: sum('openAmount'),
    wonLeads,
    lostLeads: sum('lostLeads'),
    openLeads: sum('openLeads'),
    leads,
    winRate: winRateLeads ? wonLeads / winRateLeads : null,
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
    `Won $/leads = GA4-shown rows; Lost/Open counts + win-rate denominator = lost/open ` +
    `deals flagged Google Ads?=Yes in AC (by deal cdate year). ` +
    `Not the audited ROAS report (CRM deal values, broader Google Ads? population).`;

  return {
    asOf: new Date().toISOString(),
    target: TARGET_ROAS,
    total,
    rows: section(rows, { source: SRC, status: 'live', note }),
  };
}
