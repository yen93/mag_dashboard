// Invoice Tracking — one row per Xero sales invoice (ACCREC, 2026 onwards),
// mirroring columns A–G (minus "followed up?") of the MAG "INVOICE + REVIEW
// INVITES" Google Sheet.
//
// Like the Buyer Sheet, this reads a PRE-COMPUTED cache table,
// public.invoice_tracking, which the `invoice-tracking-sync` Supabase Edge
// Function refreshes Mon–Fri 6am PH time from Xero (read-only). The dashboard
// therefore does no Xero calls at request time — it just SELECTs the table.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'Xero (Supabase cache)';

const SELECT = `
  SELECT
    invoice_id      AS "invoiceId",
    event_date      AS "eventDate",
    company         AS "company",
    ac_deal_title   AS "acDealTitle",
    invoice_number  AS "invoiceNumber",
    invoice_status  AS "invoiceStatus",
    invoice_paid    AS "invoicePaid",
    invoice_issued  AS "invoiceIssued",
    invoice_date    AS "invoiceDate"
  FROM public.invoice_tracking
  ORDER BY invoice_date DESC NULLS LAST, company ASC`;

export async function getInvoiceTracking() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      count: 0,
      rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
    };
  }

  const rows = await q(SELECT);

  let status = 'live';
  let note = `${rows.length} invoices (2026 onwards).`;
  if (!rows.length) {
    status = 'pending';
    note = 'Invoice cache is empty — the daily invoice-tracking-sync job has not populated it yet (needs the Xero Custom Connection credentials).';
  }

  return {
    asOf: new Date().toISOString(),
    count: rows.length,
    rows: section(rows, { source: SRC, status, note }),
  };
}
