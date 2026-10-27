-- Add the roas_deal_xero_backfill table as a FALLBACK for the Xero columns on roas_counted_deals.
-- A live invoice_tracking match (xt, by AC deal title) still WINS; the one-time backfill (bf, by
-- deal_id) fills deals whose invoices predate the 2026+ invoice_tracking cache. Supersedes the view
-- from 20261027140000 (adds the bf LEFT JOIN + COALESCE in the final SELECT); inner CTEs unchanged.
CREATE OR REPLACE VIEW public.roas_counted_deals AS
 WITH fy25_ids AS (
         SELECT s.deal_id,
            (array_agg(s.src ORDER BY s.pri))[1] AS source
           FROM ( SELECT clover_audited_deals.deal_id, 1 AS pri, 'clover'::text AS src
                   FROM clover_audited_deals
                  WHERE lower(btrim(clover_audited_deals.final_gads_tag)) = 'yes'::text AND clover_audited_deals.deal_id IS NOT NULL
                UNION ALL
                 SELECT mag_gads_direct_inbound_lead_source.deal_id, 2, 'jc'::text
                   FROM mag_gads_direct_inbound_lead_source
                  WHERE mag_gads_direct_inbound_lead_source.jc_final_attr = 'Could be SEO or Paid Ad'::text AND mag_gads_direct_inbound_lead_source.deal_id IS NOT NULL
                UNION ALL
                 SELECT ga4_ac_contact_source.deal_id, 3, 'ga4cpc'::text
                   FROM ga4_ac_contact_source
                  WHERE ga4_ac_contact_source.channel ~* 'cpc'::text AND ga4_ac_contact_source.deal_id IS NOT NULL) s
          GROUP BY s.deal_id
        ), xero AS (
         SELECT invoice_tracking.ac_deal_title,
            round(sum(invoice_tracking.engagement_fee)::numeric, 2) AS xero_engagement_fee,
            round(sum(invoice_tracking.gst)::numeric, 2) AS xero_gst,
            round(sum(invoice_tracking.other_fees)::numeric, 2) AS xero_other_fees,
            round(sum(invoice_tracking.amount_total)::numeric, 2) AS xero_total,
            jsonb_agg(invoice_tracking.invoice_json::jsonb) FILTER (WHERE invoice_tracking.invoice_json IS NOT NULL) AS xero_invoice_json
           FROM invoice_tracking
          WHERE invoice_tracking.ac_deal_title IS NOT NULL
          GROUP BY invoice_tracking.ac_deal_title
        ), fy25 AS (
         SELECT (i.source || '-'::text) || i.deal_id AS row_key,
            i.deal_id,
            COALESCE(con.cdate, ad.cdate) AS cdate,
                CASE ad.status WHEN 1 THEN 'won'::text WHEN 2 THEN 'lost'::text ELSE 'open'::text END AS status,
            ac_value_aud(ad.value, ad.currency) AS value,
            i.source,
            COALESCE(cad.organization, ad.title) AS org,
            COALESCE(cad.deal_crm_title, ad.title) AS title,
            con.email,
                CASE i.source WHEN 'clover'::text THEN 'Audit: Google Ads tagged'::text WHEN 'jc'::text THEN 'JC: Could be SEO or Paid Ad'::text ELSE 'GA4 cpc channel'::text END AS method,
            cad.james_comments AS comment
           FROM fy25_ids i
             JOIN activecampaign_deals ad ON ad.id = i.deal_id
             LEFT JOIN activecampaign_contacts con ON con.id = ad.contact
             LEFT JOIN clover_audited_deals cad ON cad.deal_id = i.deal_id
          WHERE lower(COALESCE(ad.title, ''::text)) !~~ 'uniting%'::text
        ), niki AS (
         SELECT 'niki-'::text || niki_ad_leads_tracking.id AS row_key,
            niki_ad_leads_tracking.deal_id,
            make_date(niki_ad_leads_tracking.year, EXTRACT(month FROM to_date(btrim(niki_ad_leads_tracking.month), 'Month'::text))::integer, 1) AS cdate,
            lower(btrim(niki_ad_leads_tracking.status)) AS status,
            niki_ad_leads_tracking.deal_value AS value,
            'niki'::text AS source,
            niki_ad_leads_tracking.company AS org,
            COALESCE(NULLIF(btrim(niki_ad_leads_tracking.product), ''::text), NULLIF(btrim(niki_ad_leads_tracking.conversion), ''::text)) AS title,
            NULL::text AS email,
            'Niki Google Ads log'::text AS method,
            niki_ad_leads_tracking.notes AS comment
           FROM niki_ad_leads_tracking
          WHERE (lower(btrim(niki_ad_leads_tracking.status)) = ANY (ARRAY['won'::text, 'lost'::text, 'open'::text])) AND lower(COALESCE(niki_ad_leads_tracking.company, ''::text)) !~~ 'uniting%'::text
        ), unioned AS (
         SELECT fy25.row_key, fy25.deal_id, fy25.cdate, fy25.status, fy25.value, fy25.source, fy25.org, fy25.title, fy25.email, fy25.method, fy25.comment FROM fy25
        UNION ALL
         SELECT niki.row_key, niki.deal_id, niki.cdate, niki.status, niki.value, niki.source, niki.org, niki.title, niki.email, niki.method, niki.comment FROM niki
        ), dedup AS (
         SELECT unioned.row_key, unioned.deal_id, unioned.cdate, unioned.status, unioned.value, unioned.source, unioned.org, unioned.title, unioned.email, unioned.method, unioned.comment,
            row_number() OVER (PARTITION BY unioned.deal_id ORDER BY (CASE unioned.source WHEN 'clover'::text THEN 1 WHEN 'jc'::text THEN 2 WHEN 'ga4cpc'::text THEN 3 ELSE 4 END)) AS rn
           FROM unioned WHERE unioned.deal_id IS NOT NULL
        ), combined AS (
         SELECT dedup.row_key, dedup.deal_id, dedup.cdate, dedup.status, dedup.value, dedup.source, dedup.org, dedup.title, dedup.email, dedup.method, dedup.comment FROM dedup WHERE dedup.rn = 1
        UNION ALL
         SELECT unioned.row_key, unioned.deal_id, unioned.cdate, unioned.status, unioned.value, unioned.source, unioned.org, unioned.title, unioned.email, unioned.method, unioned.comment FROM unioned WHERE unioned.deal_id IS NULL
        )
 SELECT combined.row_key,
    combined.deal_id,
    EXTRACT(year FROM combined.cdate)::integer + CASE WHEN EXTRACT(month FROM combined.cdate) >= 7::numeric THEN 1 ELSE 0 END AS fy_end,
    'FY'::text || "right"((EXTRACT(year FROM combined.cdate)::integer + CASE WHEN EXTRACT(month FROM combined.cdate) >= 7::numeric THEN 1 ELSE 0 END)::text, 2) AS fy,
    combined.cdate,
    combined.status,
    combined.value,
    combined.source,
    combined.org,
    combined.title,
    combined.email,
    combined.method,
    combined.comment,
    COALESCE(xt.xero_engagement_fee, bf.xero_engagement_fee) AS xero_engagement_fee,
    COALESCE(xt.xero_gst, bf.xero_gst)                       AS xero_gst,
    COALESCE(xt.xero_other_fees, bf.xero_other_fees)         AS xero_other_fees,
    COALESCE(xt.xero_total, bf.xero_total)                   AS xero_total,
    COALESCE(xt.xero_invoice_json, bf.xero_invoice_json)     AS xero_invoice_json
   FROM combined
     LEFT JOIN activecampaign_deals adx ON adx.id = combined.deal_id
     LEFT JOIN xero xt ON xt.ac_deal_title = adx.title
     LEFT JOIN roas_deal_xero_backfill bf ON bf.deal_id = combined.deal_id;
