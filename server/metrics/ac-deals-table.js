// Sales page — AC Deals table (reads public.ac_deals_ytd)

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'ActiveCampaign → ac_deals_ytd';

const SQL = `
  SELECT
    ac_deal_id          AS "acDealId",
    title,
    pipeline_id         AS "pipelineId",
    pipeline_name       AS "pipeline",
    stage_id            AS "stageId",
    stage_name          AS "stage",
    status,
    primary_contact_id  AS "contactId",
    currency,
    deal_value          AS "dealValue",
    is_bureau           AS "isBureau",
    is_tailor           AS "isTailor",
    is_inbound_inquiry  AS "isInboundInquiry",
    direct_or_indirect  AS "directOrIndirect",
    inbound_or_outbound AS "inboundOrOutbound",
    deal_created_at     AS "cdate",
    deal_updated_at     AS "mdate",
    synced_at           AS "syncedAt"
  FROM public.ac_deals_ytd
  ORDER BY deal_created_at DESC`;

export async function getAcDealsTable() {
  if (!supabaseConfigured()) {
    return { rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured.' }) };
  }

  const rows = await q(SQL);
  return {
    asOf: new Date().toISOString(),
    rows: section(rows, { source: SRC, status: 'live', note: 'ActiveCampaign deals from July 1, 2024 to present (public.ac_deals_ytd).' }),
  };
}
