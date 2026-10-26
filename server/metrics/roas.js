// ROAS (Return on Ad Spend) — Google Ads performance, by AUSTRALIAN FINANCIAL YEAR
// (Jul–Jun, END-year convention: FY25 = Jul 2024–Jun 2025), mirroring the standalone
// "MAG paid search ROAS" artifact. LIVE, computed at request time from Supabase.
//
// FY SOURCING (matches the artifact's model):
//   • FY22–FY24  →  public.niki_ad_leads_tracking (Niki's Google Ads lead log).
//       - Google spend = sum(cpc) over every lead row in the FY (per-lead click cost).
//       - Won/Lost/Open counts + won revenue (deal_value) from rows with those statuses
//         (status 'Unidentified'/'N/A' are excluded from counts but their cpc still
//         counts as spend). FY derived from year + month (no stored FY/day); FY22 is
//         partial (data starts May 2022).
//   • FY25+      →  cost + deals from live tables:
//       - Google spend = sum(cost) from public.google_ads_campaign_monthly.
//       - Bing  spend  = sum(cost) from public.bing_ads_campaign_monthly (0 until the
//         bing-ads-campaign-monthly-sync + MS Ads credentials are configured).
//       - Simple Digital fee = sum(paid_search_fee) from public.simple_digital_fees_monthly
//         (0 until the simple-digital-fees-sync routine runs).
//       - Won/Lost/Open + won revenue = COUNTED SET = clover_audited_deals
//         final_gads_tag='Yes'  UNION (by deal_id)  ga4_ac_contact_source rows whose
//         channel ~* 'cpc'. Deal value = activecampaign_deals.value joined by deal_id
//         (cents→AUD, USD converted at USD_AUD_RATE) — the SAME source the GA4 & Ads Leads
//         page displays, so the "ROAS-counted" deal values there match these figures.
//
// Two cost bases are returned per row (Google-only and All-in = Google+Bing+SD); the
// frontend toggles between them client-side. Only FYs that have ad spend are shown.
// Revenue is credited in the FY the enquiry came in (matches the artifact's timing).
//
// NB: this is a LIVE cross-check, NOT the audited ROAS report sheet's exact figures.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';
import { acValueAud } from '../lib/sql.js';

const SRC =
  'Live (Supabase): FY22–24 niki_ad_leads_tracking; FY25+ google_ads_campaign_monthly + ' +
  'bing_ads_campaign_monthly + simple_digital_fees_monthly × (clover_audited_deals ' +
  "final_gads_tag=Yes ∪ ga4_ac_contact_source channel=cpc)";
const TARGET_ROAS = 2;

const SELECT = `
  WITH niki AS (
    -- FY22–FY24: Niki's Google Ads lead log. FY derived END-year from year+month.
    -- Google spend = sum(cpc) over ALL rows (per-lead click cost). W/L/O + won$ from
    -- status rows only. Uniting = referrals, excluded from counts.
    SELECT fy_end,
      round(sum(cpc))::numeric                                            AS google_spend,
      count(*) FILTER (WHERE st IN ('won','lost','open'))                 AS leads,
      count(*) FILTER (WHERE st = 'won')                                  AS won,
      count(*) FILTER (WHERE st = 'lost')                                 AS lost,
      count(*) FILTER (WHERE st = 'open')                                 AS open,
      coalesce(sum(deal_value) FILTER (WHERE st = 'won'), 0)::numeric     AS won_rev,
      coalesce(sum(deal_value) FILTER (WHERE st = 'open'), 0)::numeric    AS open_val,
      count(DISTINCT month_num)                                           AS months
    FROM (
      SELECT cpc, deal_value, lower(btrim(status)) AS st,
        year + CASE WHEN extract(month FROM to_date(month, 'Month')) >= 7 THEN 1 ELSE 0 END AS fy_end,
        extract(month FROM to_date(month, 'Month'))::int AS month_num
      FROM public.niki_ad_leads_tracking
      WHERE lower(coalesce(company, '')) NOT LIKE 'uniting%'
    ) z
    GROUP BY fy_end
  ),
  gads AS (
    -- FY25+ Google spend (live account).
    SELECT extract(year FROM month)::int + CASE WHEN extract(month FROM month) >= 7 THEN 1 ELSE 0 END AS fy_end,
      round(sum(cost))::numeric       AS google_spend,
      count(DISTINCT month)           AS months,
      to_char(min(month), 'Mon')      AS first_month,
      to_char(max(month), 'Mon YYYY') AS last_month
    FROM public.google_ads_campaign_monthly
    GROUP BY 1
  ),
  bing AS (
    SELECT extract(year FROM month)::int + CASE WHEN extract(month FROM month) >= 7 THEN 1 ELSE 0 END AS fy_end,
      round(sum(cost))::numeric AS bing_spend
    FROM public.bing_ads_campaign_monthly
    GROUP BY 1
  ),
  sd AS (
    SELECT extract(year FROM month)::int + CASE WHEN extract(month FROM month) >= 7 THEN 1 ELSE 0 END AS fy_end,
      round(sum(paid_search_fee))::numeric AS sd_fee
    FROM public.simple_digital_fees_monthly
    GROUP BY 1
  ),
  clover_yes AS (
    -- FY25+ counted set (part 1): audited deals tagged Google Ads. fiscal_year is already
    -- END-year "FYxx". Deal value = activecampaign_deals.value (cents→AUD, USD converted)
    -- joined by deal_id — the SAME source the GA4 & Ads Leads page shows, so the two agree.
    SELECT c.deal_id,
      right(c.fiscal_year, 2)::int + 2000 AS fy_end,
      lower(btrim(c.status))              AS st,
      ${acValueAud('ad')}                 AS val
    FROM public.clover_audited_deals c
    LEFT JOIN public.activecampaign_deals ad ON ad.id::text = c.deal_id::text
    WHERE lower(btrim(c.final_gads_tag)) = 'yes'
      AND c.fiscal_year ~ '^FY[0-9]{2}$'
      AND lower(coalesce(c.deal_crm_title, '')) NOT LIKE 'uniting%'
  ),
  ga4cpc AS (
    -- FY25+ counted set (part 2): GA4-matched contacts on a cpc channel. FY derived END-year
    -- from cdate (do NOT trust the generated START-year fy column). Deal value =
    -- activecampaign_deals.value (cents→AUD, USD converted) by deal_id — same source as the page.
    SELECT cs.deal_id,
      extract(year FROM cs.cdate)::int + CASE WHEN extract(month FROM cs.cdate) >= 7 THEN 1 ELSE 0 END AS fy_end,
      lower(btrim(cs.deal_status)) AS st,
      ${acValueAud('ad')}          AS val
    FROM public.ga4_ac_contact_source cs
    LEFT JOIN public.activecampaign_deals ad ON ad.id::text = cs.deal_id::text
    WHERE cs.channel ~* 'cpc'
      AND cs.deal_id IS NOT NULL
      AND lower(coalesce(cs.deal_title, '')) NOT LIKE 'uniting%'
  ),
  combined_deals AS (
    SELECT deal_id, fy_end, st, val FROM clover_yes
    UNION ALL
    SELECT deal_id, fy_end, st, val FROM ga4cpc g
    WHERE g.deal_id NOT IN (SELECT deal_id FROM clover_yes WHERE deal_id IS NOT NULL)
  ),
  clover_fy AS (
    SELECT fy_end,
      count(*) FILTER (WHERE st IN ('won','lost','open'))             AS leads,
      count(*) FILTER (WHERE st = 'won')                             AS won,
      count(*) FILTER (WHERE st = 'lost')                            AS lost,
      count(*) FILTER (WHERE st = 'open')                            AS open,
      coalesce(sum(val) FILTER (WHERE st = 'won'), 0)::numeric       AS won_rev,
      coalesce(sum(val) FILTER (WHERE st = 'open'), 0)::numeric      AS open_val
    FROM combined_deals
    GROUP BY fy_end
  ),
  fy_axis AS (
    SELECT fy_end FROM niki WHERE fy_end <= 2024 AND google_spend > 0
    UNION
    SELECT fy_end FROM gads WHERE fy_end >= 2025
  )
  SELECT
    a.fy_end                                                           AS "fyEnd",
    'FY' || right(a.fy_end::text, 2)                                   AS "fy",
    (CASE WHEN a.fy_end <= 2024 THEN n.google_spend ELSE g.google_spend END)       AS "googleSpend",
    coalesce(b.bing_spend, 0)                                                      AS "bingSpend",
    coalesce(s.sd_fee, 0)                                                          AS "sdFee",
    (CASE WHEN a.fy_end <= 2024 THEN coalesce(n.won, 0)  ELSE coalesce(c.won, 0)  END)  AS "won",
    (CASE WHEN a.fy_end <= 2024 THEN coalesce(n.lost, 0) ELSE coalesce(c.lost, 0) END)  AS "lost",
    (CASE WHEN a.fy_end <= 2024 THEN coalesce(n.open, 0) ELSE coalesce(c.open, 0) END)  AS "open",
    (CASE WHEN a.fy_end <= 2024 THEN coalesce(n.leads, 0) ELSE coalesce(c.leads, 0) END) AS "leads",
    (CASE WHEN a.fy_end <= 2024 THEN coalesce(n.won_rev, 0)  ELSE coalesce(c.won_rev, 0)  END) AS "wonRevenue",
    (CASE WHEN a.fy_end <= 2024 THEN coalesce(n.open_val, 0) ELSE coalesce(c.open_val, 0) END) AS "openValue",
    (CASE WHEN a.fy_end <= 2024 THEN n.months ELSE g.months END)       AS "spendMonths",
    (CASE WHEN a.fy_end <= 2024 THEN NULL ELSE g.first_month END)      AS "firstSpendMonth",
    (CASE WHEN a.fy_end <= 2024 THEN NULL ELSE g.last_month END)       AS "lastSpendMonth",
    (CASE WHEN a.fy_end <= 2024 THEN 'niki' ELSE 'clover+ga4' END)     AS "sourceKind"
  FROM fy_axis a
  LEFT JOIN niki n     ON n.fy_end = a.fy_end
  LEFT JOIN gads g     ON g.fy_end = a.fy_end
  LEFT JOIN bing b     ON b.fy_end = a.fy_end
  LEFT JOIN sd   s     ON s.fy_end = a.fy_end
  LEFT JOIN clover_fy c ON c.fy_end = a.fy_end
  ORDER BY a.fy_end`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

// Derive the per-row figures the page shows. Both cost bases are provided; the frontend
// picks one. ROI is basis-dependent so the frontend derives it from the active basis.
function shape(r) {
  const fyEnd = num(r.fyEnd);
  const googleSpend = num(r.googleSpend) || 0;
  const bingSpend = num(r.bingSpend) || 0;
  const sdFee = num(r.sdFee) || 0;
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
  const countedMethod =
    r.sourceKind === 'niki'
      ? `Niki's Google Ads log. Google spend = summed per-lead cost (cpc); Won/Lost/Open + ` +
        `won revenue from logged deals. ${partial ? `Partial year (${spendMonths} mo of data). ` : ''}`
      : `Won/Lost/Open = audited deals tagged Google Ads (final_gads_tag=Yes) plus GA4 cpc-channel ` +
        `deals. Cost = Google Ads${bingSpend ? ' + Bing' : ''}${sdFee ? ' + Simple Digital' : ''} ` +
        `(${spendMonths} mo${r.firstSpendMonth && r.lastSpendMonth ? `, ${r.firstSpendMonth}–${r.lastSpendMonth}` : ''}).`;
  return {
    fy: r.fy,
    fyEnd,
    periodLabel,
    googleSpend,
    bingSpend,
    sdFee,
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
        note: 'No ad spend found — populate niki_ad_leads_tracking (FY22–24) or google_ads_campaign_monthly (FY25+).',
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
    `FY22–24 from Niki's log; FY25+ Won/Lost/Open = audit final_gads_tag=Yes ∪ GA4 cpc. ` +
    (anyBing ? '' : 'Bing spend not yet connected (reads $0). ') +
    (anySd ? '' : 'Simple Digital fee not yet connected (reads $0). ') +
    `Revenue credited in the FY the enquiry came in.`;

  return {
    asOf: new Date().toISOString(),
    target: TARGET_ROAS,
    total,
    rows: section(rows, { source: SRC, status: 'live', note }),
  };
}
