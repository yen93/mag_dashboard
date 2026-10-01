// LIV pipeline deals — a per-deal row list for the Sales page table.
//
// Pipeline "Keynotes // Workshops // Immersive (LIV)" = activecampaign_deals."group" = '3'.
// Scope: deals CREATED in 2026 (cdate in [2026-01-01, 2027-01-01)).
//
// Unlike a live composer, this reads a PRE-COMPUTED cache table,
// public.sales_liv_deals, which the `sales-deals-sync` Supabase Edge Function
// refreshes Mon–Fri 6am PH time: 10 base columns from the Supabase AC mirror
// (date, account, contact, replied-from-stage, status, demo date, proposal
// sent, owner id) plus 6 columns enriched from the ActiveCampaign API (lead
// type, job title, last note + date, owner NAME, Magalog). The dashboard
// therefore makes NO ActiveCampaign calls at request time — it just SELECTs the
// table, so this stays fast and never fails on an AC outage.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'Supabase + ActiveCampaign (Supabase cache)';
const MAX_ATTEMPTS = 2; // matches the edge function's MAX_ENRICH_ATTEMPTS

const SELECT = `
  SELECT
    deal_id        AS "id",
    date_created   AS "dateCreated",
    account        AS "account",
    account_id     AS "accountId",
    lead_type      AS "leadType",
    contact        AS "contact",
    contact_id     AS "contactId",
    job_title      AS "jobTitle",
    last_note      AS "lastNote",
    last_note_date AS "lastNoteDate",
    owner          AS "owner",
    replied        AS "replied",
    status         AS "status",
    demo_date      AS "demoDate",
    proposal_sent  AS "proposalSent",
    magalog_sent   AS "magalogSent",
    enriched_at    AS "enrichedAt",
    enrichment_attempts AS "enrichmentAttempts"
  FROM public.sales_liv_deals
  WHERE in_scope = true
  ORDER BY date_created DESC`;

export async function getLivDeals() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      count: 0,
      deals: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
    };
  }

  const rows = await q(SELECT);

  // Enrichment progress drives the source chip, mirroring the Buyer Sheet page.
  const pending = rows.filter((r) => !r.enrichedAt && Number(r.enrichmentAttempts || 0) < MAX_ATTEMPTS).length;

  // Internal bookkeeping — don't expose it on the page.
  for (const r of rows) { delete r.enrichedAt; delete r.enrichmentAttempts; }

  let status = 'live';
  let note = 'Pipeline: Keynotes // Workshops // Immersive (LIV) · deals created in 2026 · Supabase cache, refreshed Mon–Fri 6am PH';
  if (!rows.length) {
    status = 'pending';
    note = 'Deals cache is empty — the daily sales-deals-sync job has not populated it yet.';
  } else if (pending > 0) {
    status = 'partial';
    note = `${rows.length} deals · ${pending} still awaiting ActiveCampaign enrichment on the daily sync.`;
  }

  return {
    asOf: new Date().toISOString(),
    count: rows.length,
    deals: section(rows, { source: SRC, status, note }),
  };
}
