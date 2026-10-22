// ROAS deals — the per-FY deal list behind the ROAS page's deals table. Mirrors the
// artifact's "Deals" section. LIVE from Supabase, same FY sourcing as roas.js:
//   • FY22–FY24: public.niki_ad_leads_tracking (Won/Lost/Open rows) → group 'counted'.
//   • FY25+    : public.clover_audited_deals classified by its Google-Ads signals —
//       - group 'counted' = final_gads_tag='Yes' (the counted set) + GA4 cpc-channel
//         deals not present in the audit,
//       - group 'review'  = final_gads_tag='Uncertain' (James still to decide),
//       - group 'actag'   = attributed Google Ads (effective attribution) but NOT counted.
// The frontend filters this flat list client-side by FY + status + group + search.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC =
  'Live (Supabase): FY22–24 niki_ad_leads_tracking; FY25+ clover_audited_deals ' +
  '(final_gads_tag / attribution) ∪ ga4_ac_contact_source channel=cpc';

const SELECT = `
  WITH niki AS (
    SELECT 'niki-' || id AS key,
      year + CASE WHEN extract(month FROM to_date(month, 'Month')) >= 7 THEN 1 ELSE 0 END AS fy_end,
      month || ' ' || year                         AS date,
      company                                       AS org,
      coalesce(nullif(btrim(product), ''), nullif(btrim(conversion), '')) AS title,
      initcap(lower(btrim(status)))                 AS status,
      deal_value                                    AS value,
      'Niki''s Google Ads log'                      AS method,
      notes                                         AS comment,
      'counted'                                     AS grp
    FROM public.niki_ad_leads_tracking
    WHERE lower(btrim(status)) IN ('won','lost','open')
      AND lower(coalesce(company, '')) NOT LIKE 'uniting%'
  ),
  clover_src AS (
    SELECT deal_id,
      right(fiscal_year, 2)::int + 2000 AS fy_end,
      inquiry_date                      AS date,
      organization                      AS org,
      deal_crm_title                    AS title,
      initcap(lower(btrim(status)))     AS status,
      nullif(regexp_replace(coalesce(deal_value_aud_crm, ''), '[^0-9.]', '', 'g'), '')::numeric AS value,
      lower(btrim(final_gads_tag))      AS gtag,
      coalesce(nullif(btrim(james_final_attribution), ''), nullif(btrim(attribution), '')) AS eff_attr,
      james_comments                    AS comment
    FROM public.clover_audited_deals
    WHERE fiscal_year ~ '^FY[0-9]{2}$'
      AND right(fiscal_year, 2)::int + 2000 >= 2025
      AND lower(coalesce(deal_crm_title, '')) NOT LIKE 'uniting%'
  ),
  cpc_ids AS (
    -- Every GA4 cpc-channel deal id. The counted set = clover Yes ∪ these (matches roas.js).
    SELECT DISTINCT deal_id FROM public.ga4_ac_contact_source
    WHERE channel ~* 'cpc' AND deal_id IS NOT NULL
  ),
  clover AS (
    SELECT 'clv-' || deal_id AS key, deal_id, fy_end, date, org, title, status, value,
      CASE WHEN gtag = 'yes' THEN 'Audit: Google Ads tagged'
           WHEN deal_id IN (SELECT deal_id FROM cpc_ids) THEN 'GA4 cpc channel'
           WHEN eff_attr IS NOT NULL THEN 'Audit: ' || eff_attr
           ELSE 'Audit' END AS method,
      comment,
      CASE WHEN gtag = 'yes' OR deal_id IN (SELECT deal_id FROM cpc_ids) THEN 'counted'
           WHEN gtag = 'uncertain' THEN 'review'
           ELSE 'actag' END AS grp
    FROM clover_src
    WHERE gtag IN ('yes','uncertain')
       OR deal_id IN (SELECT deal_id FROM cpc_ids)
       OR lower(coalesce(eff_attr, '')) IN ('google ads','could be seo or paid ad')
  ),
  ga4cpc AS (
    -- GA4 cpc-channel deals not present in the audit at all → counted (part 2 of the set).
    SELECT 'ga4-' || cs.deal_id AS key, cs.deal_id,
      extract(year FROM cs.cdate)::int + CASE WHEN extract(month FROM cs.cdate) >= 7 THEN 1 ELSE 0 END AS fy_end,
      to_char(cs.cdate, 'DD Mon YYYY') AS date,
      cs.deal_title                    AS org,
      cs.deal_title                    AS title,
      initcap(lower(btrim(cs.deal_status))) AS status,
      cs.deal_value                    AS value,
      'GA4 cpc channel'                AS method,
      NULL                             AS comment,
      'counted'                        AS grp
    FROM public.ga4_ac_contact_source cs
    WHERE cs.channel ~* 'cpc'
      AND cs.deal_id IS NOT NULL
      AND lower(coalesce(cs.deal_title, '')) NOT LIKE 'uniting%'
      AND (extract(year FROM cs.cdate)::int + CASE WHEN extract(month FROM cs.cdate) >= 7 THEN 1 ELSE 0 END) >= 2025
      AND cs.deal_id NOT IN (SELECT deal_id FROM clover_src)
  )
  SELECT key, 'FY' || right(fy_end::text, 2) AS "fy", fy_end AS "fyEnd",
    date AS "date", org AS "org", title AS "title", status AS "status",
    value AS "value", method AS "method", comment AS "comment", grp AS "group"
  FROM (
    SELECT key, fy_end, date, org, title, status, value, method, comment, grp FROM niki WHERE fy_end <= 2024
    UNION ALL
    SELECT key, fy_end, date, org, title, status, value, method, comment, grp FROM clover
    UNION ALL
    SELECT key, fy_end, date, org, title, status, value, method, comment, grp FROM ga4cpc
  ) u
  ORDER BY fy_end DESC, status, value DESC NULLS LAST`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

export async function getRoasDeals() {
  if (!supabaseConfigured()) {
    return { asOf: new Date().toISOString(), rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }) };
  }
  const rows = (await q(SELECT)).map((r) => ({
    key: r.key,
    fy: r.fy,
    fyEnd: num(r.fyEnd),
    date: r.date || '',
    org: r.org || '',
    title: r.title || '',
    status: r.status || '',
    value: num(r.value),
    method: r.method || '',
    comment: r.comment || '',
    group: r.group || '',
  }));
  return {
    asOf: new Date().toISOString(),
    rows: section(rows, {
      source: SRC,
      status: 'live',
      note: `${rows.length} deals across FY. FY22–24 from Niki's log; FY25+ from the ROAS audit (+GA4 cpc).`,
    }),
  };
}
