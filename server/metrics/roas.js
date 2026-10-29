// ROAS (Return on Ad Spend) — Google Ads performance, by AUSTRALIAN FINANCIAL YEAR
// (Jul–Jun, END-year convention: FY25 = Jul 2024–Jun 2025), mirroring the standalone
// "MAG paid search ROAS" artifact. LIVE, computed at request time from Supabase.
//
// DEAL COUNTS + won$/open$ come from the canonical deal-grained view public.roas_counted_deals
// (migration roas_counted_deals_view) — the SINGLE source of truth shared with roas-deals.js and
// the GA4 & Ads Leads page's "ROAS-counted only" view, so all three reconcile. The view resolves
// each deal's FY and value itself (niki = its own logged month + sheet value; clover/jc/ga4 =
// contact cdate + activecampaign_deals value via ac_value_aud), deduped by deal_id with clover
// prevailing. This file only GROUPs that view by FY for the counts; it does NOT re-derive the set.
//
// AD SPEND (NOT from the view):
//   • Google (ALL FYs) →  sum(cost) public.google_ads_xero_monthly — Xero billed charges
//                 (account 302 "Advertising", ex-GST), filled by xero-ad-spend-sync. This
//                 REPLACED the old split (Niki per-lead cpc FY22–24 + google_ads_campaign_monthly
//                 / Google Ads API FY25+): all Google Ads cost now comes from Xero.
//   • Bing / Simple Digital (All-in basis) →  sum(cost) public.bing_ads_campaign_monthly;
//                 sum(paid_search_fee) public.simple_digital_fees_monthly (both live from Xero
//                 via xero-ad-spend-sync too).
//
// Two cost bases are returned per row (Google-only and All-in = Google+Bing+SD); the
// frontend toggles between them client-side. Only FYs that have ad spend are shown.
// Revenue is credited in the FY the enquiry came in (matches the artifact's timing).
//
// NB: this is a LIVE cross-check, NOT the audited ROAS report sheet's exact figures.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC =
  'Live (Supabase): deal counts + won$/open$ from the public.roas_counted_deals view ' +
  '(FY22–24 niki_ad_leads_tracking; FY25+ clover_audited_deals Yes ∪ ga4 cpc); ' +
  'Google Ads spend (all FYs) from Xero (public.google_ads_xero_monthly); ' +
  'Bing + Simple Digital from bing_ads_campaign_monthly / simple_digital_fees_monthly (Xero)';
const TARGET_ROAS = 2;

const SELECT = `
  WITH deals AS (
    -- Deal counts + won$/open$ come from the canonical deal-grained view (single source of
    -- truth, shared with roas-deals.js and the GA4 & Ads Leads "ROAS-counted only" view).
    -- FY is already resolved per-source inside the view (niki = its own logged month;
    -- clover/jc/ga4 = contact cdate). Value is AUD (ac_value_aud).
    -- WON REVENUE uses the actual billed Xero ENGAGEMENT FEE where the deal is invoiced
    -- (xero_engagement_fee), falling back to the AC/niki contracted value otherwise — so ROAS,
    -- the charts and the ROAS-by-FY table reflect billed fees where known without losing coverage.
    SELECT fy_end,
      count(*) FILTER (WHERE status IN ('won','lost','open'))         AS leads,
      count(*) FILTER (WHERE status = 'won')                          AS won,
      count(*) FILTER (WHERE status = 'lost')                         AS lost,
      count(*) FILTER (WHERE status = 'open')                         AS open,
      coalesce(sum(coalesce(xero_engagement_fee, value)) FILTER (WHERE status = 'won'), 0)::numeric AS won_rev,
      coalesce(sum(value) FILTER (WHERE status = 'open'), 0)::numeric AS open_val
    FROM public.roas_counted_deals
    GROUP BY fy_end
  ),
  gads_xero AS (
    -- Google Ads spend for EVERY FY = Xero billed charges (account 302, ex-GST),
    -- from public.google_ads_xero_monthly (xero-ad-spend-sync). This REPLACES the
    -- old split (Niki's per-lead cpc FY22–24 + google_ads_campaign_monthly /
    -- Google Ads API FY25+) — all Google cost now comes from Xero.
    SELECT extract(year FROM month)::int + CASE WHEN extract(month FROM month) >= 7 THEN 1 ELSE 0 END AS fy_end,
      round(sum(cost))::numeric       AS google_spend,
      count(DISTINCT month)           AS months,
      to_char(min(month), 'Mon')      AS first_month,
      to_char(max(month), 'Mon YYYY') AS last_month
    FROM public.google_ads_xero_monthly
    GROUP BY 1
  ),
  bing AS (
    SELECT extract(year FROM month)::int + CASE WHEN extract(month FROM month) >= 7 THEN 1 ELSE 0 END AS fy_end,
      round(sum(cost))::numeric AS bing_spend
    FROM public.bing_ads_campaign_monthly
    GROUP BY 1
  ),
  sd AS (
    -- paid_search_fee is the ROAS cost (SEO already stripped out); seo_component is the
    -- billed-but-excluded SEO portion, surfaced separately for display only.
    SELECT extract(year FROM month)::int + CASE WHEN extract(month FROM month) >= 7 THEN 1 ELSE 0 END AS fy_end,
      round(sum(paid_search_fee))::numeric            AS sd_fee,
      round(sum(coalesce(seo_component, 0)))::numeric AS sd_seo
    FROM public.simple_digital_fees_monthly
    GROUP BY 1
  ),
  fy_axis AS (
    -- Only FYs with Google Ads spend (from Xero) are shown.
    SELECT fy_end FROM gads_xero WHERE google_spend > 0
  )
  SELECT
    a.fy_end                                                           AS "fyEnd",
    'FY' || right(a.fy_end::text, 2)                                   AS "fy",
    g.google_spend                                                    AS "googleSpend",
    coalesce(b.bing_spend, 0)                                          AS "bingSpend",
    coalesce(s.sd_fee, 0)                                              AS "sdFee",
    coalesce(s.sd_seo, 0)                                              AS "sdSeo",
    coalesce(d.won, 0)                                                 AS "won",
    coalesce(d.lost, 0)                                                AS "lost",
    coalesce(d.open, 0)                                                AS "open",
    coalesce(d.leads, 0)                                               AS "leads",
    coalesce(d.won_rev, 0)                                             AS "wonRevenue",
    coalesce(d.open_val, 0)                                            AS "openValue",
    g.months                                                          AS "spendMonths",
    g.first_month                                                     AS "firstSpendMonth",
    g.last_month                                                      AS "lastSpendMonth",
    (CASE WHEN a.fy_end <= 2024 THEN 'niki' ELSE 'clover+ga4' END)     AS "sourceKind"
  FROM fy_axis a
  LEFT JOIN deals d     ON d.fy_end = a.fy_end
  LEFT JOIN gads_xero g ON g.fy_end = a.fy_end
  LEFT JOIN bing b      ON b.fy_end = a.fy_end
  LEFT JOIN sd   s      ON s.fy_end = a.fy_end
  ORDER BY a.fy_end`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

// Derive the per-row figures the page shows. Both cost bases are provided; the frontend
// picks one. ROI is basis-dependent so the frontend derives it from the active basis.
function shape(r) {
  const fyEnd = num(r.fyEnd);
  const googleSpend = num(r.googleSpend) || 0;
  const bingSpend = num(r.bingSpend) || 0;
  const sdFee = num(r.sdFee) || 0;
  const sdSeo = num(r.sdSeo) || 0; // SEO portion of the SD charge — display only, NOT in totalCost
  const totalCost = googleSpend + bingSpend + sdFee;
  const won = num(r.won) || 0;
  const lost = num(r.lost) || 0;
  const open = num(r.open) || 0;
  const leads = won + lost + open;
  const wonRevenue = num(r.wonRevenue) || 0;
  const openValue = num(r.openValue) || 0;
  const spendMonths = num(r.spendMonths) || 0;
  const partial = spendMonths > 0 && spendMonths < 12;
  const periodLabel = partial ? `${r.fy} · ${spendMonths} mo` : r.fy;
  // Cost is always Xero billed Google Ads (acct 302); the deal-count source still
  // differs by era (Niki's log FY22–24, audit∪GA4-cpc FY25+).
  const costText =
    `Cost = Google Ads billed via Xero${bingSpend ? ' + Bing' : ''}${sdFee ? ' + Simple Digital' : ''} ` +
    `(${spendMonths} mo${partial ? ', partial' : ''}` +
    `${r.firstSpendMonth && r.lastSpendMonth ? `, ${r.firstSpendMonth}–${r.lastSpendMonth}` : ''}).`;
  const dealText =
    r.sourceKind === 'niki'
      ? `Won/Lost/Open + won revenue from Niki's Google Ads log.`
      : `Won/Lost/Open = audited deals tagged Google Ads (final_gads_tag=Yes) plus GA4 cpc-channel deals.`;
  const countedMethod = `${costText} ${dealText}`;
  return {
    fy: r.fy,
    fyEnd,
    periodLabel,
    googleSpend,
    bingSpend,
    sdFee,
    sdSeo,
    totalCost,
    won,
    lost,
    open,
    leads,
    wonRevenue,
    openValue,
    winRate: leads ? won / leads : null,
    roasGoogle: googleSpend ? wonRevenue / googleSpend : null,
    roasAllin: totalCost ? wonRevenue / totalCost : null,
    perLeadValue: leads ? wonRevenue / leads : null,
    spendMonths,
    partial,
    countedMethod,
    sourceKind: r.sourceKind,
    targetRoas: TARGET_ROAS,
  };
}

// "All years" total — summed; ratios recomputed, not summed.
function totalRow(rows) {
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const googleSpend = sum('googleSpend');
  const bingSpend = sum('bingSpend');
  const sdFee = sum('sdFee');
  const sdSeo = sum('sdSeo');
  const totalCost = googleSpend + bingSpend + sdFee;
  const won = sum('won');
  const lost = sum('lost');
  const open = sum('open');
  const leads = won + lost + open;
  const wonRevenue = sum('wonRevenue');
  return {
    fy: 'All',
    fyEnd: null,
    periodLabel: 'All years',
    googleSpend,
    bingSpend,
    sdFee,
    sdSeo,
    totalCost,
    won,
    lost,
    open,
    leads,
    wonRevenue,
    openValue: sum('openValue'),
    winRate: leads ? won / leads : null,
    roasGoogle: googleSpend ? wonRevenue / googleSpend : null,
    roasAllin: totalCost ? wonRevenue / totalCost : null,
    perLeadValue: leads ? wonRevenue / leads : null,
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
        note: 'No Google Ads spend found — populate public.google_ads_xero_monthly (run xero-ad-spend-sync).',
      }),
    };
  }

  const total = totalRow(rows);
  const anyBing = rows.some((r) => r.bingSpend > 0);
  const anySd = rows.some((r) => r.sdFee > 0);
  const note =
    `${rows.length} FY(s) with ad spend (${rows[0].fy}–${rows[rows.length - 1].fy}). ` +
    `All-years ROAS: Google ${total.roasGoogle ? total.roasGoogle.toFixed(2) : '—'}× · ` +
    `All-in ${total.roasAllin ? total.roasAllin.toFixed(2) : '—'}× vs ${TARGET_ROAS.toFixed(2)}× target. ` +
    `Google Ads cost (all FYs) = Xero billed charges. Deal counts: FY22–24 from Niki's log; ` +
    `FY25+ = audit final_gads_tag=Yes ∪ GA4 cpc. ` +
    (anyBing ? '' : 'Bing spend not yet connected (reads $0). ') +
    (anySd ? '' : 'Simple Digital fee not yet connected (reads $0). ') +
    `Won revenue = billed Xero engagement fee where invoiced, else contracted value. ` +
    `Revenue credited in the FY the enquiry came in.`;

  return {
    asOf: new Date().toISOString(),
    target: TARGET_ROAS,
    total,
    rows: section(rows, { source: SRC, status: 'live', note }),
  };
}
