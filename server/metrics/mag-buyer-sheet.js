// MAG Buyer Sheet — a per-deal row list mirroring the "MAG Buyer Analysis"
// Google Sheet (tabs 2026/2027).
//
// Unlike the live metrics composers, this reads a PRE-COMPUTED cache table,
// public.mag_buyer_sheet, which the `buyer-sheet-sync` Supabase Edge Function
// refreshes Mon–Fri 6am PH time from ActiveCampaign (deal + account + contact +
// custom fields) and OpenAI web search (Business Size / Seniority / Key decision
// maker). The dashboard therefore does no AC/OpenAI calls at request time — it
// just SELECTs the table, so this stays fast and cheap.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'ActiveCampaign + OpenAI (Supabase cache)';

const SELECT = `
  SELECT
    deal_id            AS "dealId",
    year               AS "year",
    event_date         AS "eventDate",
    company            AS "company",
    direct_indirect    AS "directIndirect",
    program_delivered  AS "program",
    audience_size      AS "audienceSize",
    value_aud          AS "valueAud",
    currency           AS "currency",
    industry           AS "industry",
    business_size      AS "businessSize",
    ipoc_name          AS "ipocName",
    ipoc_email         AS "ipocEmail",
    ipoc_job_title     AS "ipocTitle",
    ipoc_seniority     AS "ipocSeniority",
    kdm_name           AS "kdmName",
    kdm_email          AS "kdmEmail",
    kdm_job_title      AS "kdmTitle",
    kdm_seniority      AS "kdmSeniority",
    enriched_at        AS "enrichedAt",
    enrichment_attempts AS "enrichmentAttempts"
  FROM public.mag_buyer_sheet
  -- deal_status / lost_at are tracked in the table but intentionally NOT served
  -- to the page (backend-only tracking, per request).
  ORDER BY event_date DESC NULLS LAST, company ASC`;

export async function getMagBuyerSheet() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      count: 0,
      rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
    };
  }

  // Matches the edge function's MAX_ENRICH_ATTEMPTS: a row that has failed this
  // many web-search lookups is "parked" (left blank on purpose), not pending.
  const MAX_ATTEMPTS = 2;
  const rows = await q(SELECT);

  const enriched = rows.filter((r) => r.enrichedAt).length;
  const pending = rows.filter((r) => !r.enrichedAt && Number(r.enrichmentAttempts || 0) < MAX_ATTEMPTS).length;
  const unverified = rows.length - enriched - pending; // parked — couldn't be verified online

  // enrichmentAttempts is internal bookkeeping — don't expose it on the page.
  for (const r of rows) delete r.enrichmentAttempts;

  // "partial" only while rows are still actively waiting to be enriched; once the
  // backfill has done everything it can (parked rows will never resolve on their
  // own), the table is considered live.
  let status = 'live';
  let note = `${rows.length} won buyers · all enriched.`;
  if (!rows.length) {
    status = 'pending';
    note = 'Buyer sheet cache is empty — the daily buyer-sheet-sync job has not populated it yet.';
  } else if (pending > 0) {
    status = 'partial';
    note = `Buyer enrichment filled on ${enriched}/${rows.length} rows; ${pending} still to backfill on the daily sync.`;
  } else if (unverified > 0) {
    note = `${rows.length} won buyers · ${enriched} enriched; ${unverified} companies couldn't be verified online and are left blank.`;
  }

  return {
    asOf: new Date().toISOString(),
    count: rows.length,
    rows: section(rows, { source: SRC, status, note }),
  };
}
