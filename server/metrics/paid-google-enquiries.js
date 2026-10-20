// Historical Paid Leads — the 39 "Paid – Google" reconciled enquiries.
//
// Reads a PRE-COMPUTED cache table, public.mag_paid_google_enquiries. The set is
// anchored to the 39 AC deal_ids the MAG Enquiry & Deal Reconciliation sheet
// classified as "Paid – Google" (seeded once); the display fields are refreshed
// daily from the Supabase ActiveCampaign mirror by the paid-google-enquiries-sync
// edge function (upsert on deal_id, never truncate). The dashboard does no sheet
// or AC calls at request time — it SELECTs this one table, so this stays fast.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'ActiveCampaign mirror (Supabase cache) · reconciled "Paid – Google" set';

// Single-table read, aliased to the camelCase keys the page expects.
const SELECT = `
  SELECT
    p.deal_id              AS "dealId",
    p.contact_created      AS "contactCreated",
    p.enquiry_date         AS "enquiryDate",
    p.organisation         AS "organisation",
    p.contact              AS "contact",
    p.email                AS "email",
    p.email_domain         AS "emailDomain",
    p.deal_title           AS "dealTitle",
    p.pipeline             AS "pipeline",
    p.type_of_engagement   AS "typeOfEngagement",
    p.confidence           AS "confidence",
    p.evidence             AS "evidence",
    p.check_with_sales     AS "checkWithSales",
    p.outcome              AS "outcome",
    p.stage                AS "stage",
    p.deal_value_aud       AS "dealValue",
    p.won_value_aud        AS "wonValue",
    p.won_date             AS "wonDate",
    p.google_ads_field     AS "googleAdsField",
    p.deal_source_field    AS "dealSourceField",
    p.ac_lead_source_field AS "acLeadSourceField",
    p.source_tags_raw      AS "sourceTagsRaw",
    p.source_reconciled    AS "sourceReconciled"
  FROM public.mag_paid_google_enquiries p
  ORDER BY p.contact_created DESC NULLS LAST`;

export async function getPaidGoogleEnquiries() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      count: 0,
      rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
    };
  }

  const rows = await q(SELECT);
  const won = rows.filter((r) => r.outcome === 'won').length;

  let status = 'live';
  let note = `${rows.length} reconciled Paid – Google enquiries · ${won} won.`;
  if (!rows.length) {
    status = 'pending';
    note = 'Paid – Google cache is empty — run the paid-google-enquiries-sync edge function (or wait for its daily 06:30 PH run).';
  }

  return {
    asOf: new Date().toISOString(),
    count: rows.length,
    rows: section(rows, { source: SRC, status, note }),
  };
}
