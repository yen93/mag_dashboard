// AC Ad Leads Tagging — AC contacts carrying tag id 88
// ("[WEBSITE] google-ads-click-through"), with their deal rollups + a primary deal.
//
// Reads a PRE-COMPUTED cache table, public.ac_ad_leads_tagging, filled Mon-Fri
// 06:00 PH by the ac-ad-leads-sync edge function (tag membership from the AC API,
// deals joined from the activecampaign_deals mirror). The dashboard does no AC
// calls at request time — it just SELECTs the table, so this stays fast. Plain
// SELECT → short cache is plenty. All date-range/filter/sort/search is client-side.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'ActiveCampaign tag 88 + deals mirror (Supabase cache)';

const SELECT = `
  SELECT
    contact_id          AS "contactId",
    email               AS "email",
    first_name          AS "firstName",
    last_name           AS "lastName",
    phone               AS "phone",
    contact_cdate       AS "contactCdate",
    tagged_at           AS "taggedAt",
    deals_count         AS "dealsCount",
    won_deals_count     AS "wonDealsCount",
    open_deals_count    AS "openDealsCount",
    lost_deals_count    AS "lostDealsCount",
    deal_value_total    AS "dealValueTotal",
    won_value_total     AS "wonValueTotal",
    open_value_total    AS "openValueTotal",
    primary_deal_title  AS "primaryDealTitle",
    primary_deal_value  AS "primaryDealValue",
    primary_deal_status AS "primaryDealStatus",
    primary_deal_cdate  AS "primaryDealCdate",
    currency            AS "currency"
  FROM public.ac_ad_leads_tagging
  ORDER BY contact_cdate DESC NULLS LAST`;

export async function getAcAdLeads() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      count: 0,
      rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
    };
  }

  const rows = await q(SELECT);
  const withDeal = rows.filter((r) => Number(r.dealsCount) > 0).length;

  let status = 'live';
  let note = `${rows.length} tagged leads · ${withDeal} with a deal.`;
  if (!rows.length) {
    status = 'pending';
    note = 'AC ad-leads cache is empty — run the ac-ad-leads-sync edge function (?sync=1) to populate it.';
  }

  return {
    asOf: new Date().toISOString(),
    count: rows.length,
    rows: section(rows, { source: SRC, status, note }),
  };
}
