// Alternate Leads — Liv's review queue (replaces the old "alternate_leads_found" Google Sheet).
//
// Source: public.alternate_leads (plain SELECT). A lead is FOR REVIEW while
// is_processed IS NULL AND status IS NULL AND sheet_remark IS NULL. Reviewing sets `status`:
//   'Send intro' = approved for the intro email · 'skip' = not pursued.
// (sheet_remark is only the legacy one-time copy of the old sheet: read as a fallback for the
// 74 leads tagged there, never written.)

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC = 'Supabase → alternate_leads';
export const REMARK_SEND = 'Send intro';
export const REMARK_SKIP = 'skip';

const SQL = `
  SELECT
    l.id, l.lead_type, l.org, l.poc_firstname, l.poc_lastname, l.poc_role, l.email,
    l.speaker, l.event, l.subject, l.source_table, l.status AS review_status,
    l.is_processed, l.sheet_remark,
    COALESCE(l.datetime_logged, l.created_at) AS found_at,
    rv.set_by AS reviewed_by, rv.created_at AS reviewed_at
  FROM public.alternate_leads l
  LEFT JOIN LATERAL (
    SELECT set_by, created_at FROM public.alternate_leads_review_log g
    WHERE g.lead_id = l.id AND g.action = 'set' ORDER BY g.created_at DESC LIMIT 1
  ) rv ON TRUE
  ORDER BY COALESCE(l.datetime_logged, l.created_at) DESC, l.id DESC`;

function classify(r) {
  const remark = (r.review_status || r.sheet_remark || '').trim();   // status wins; legacy remark fallback
  let review;
  if (remark.toLowerCase() === REMARK_SEND.toLowerCase()) review = 'send';
  else if (remark) review = 'skip';                 // 'skip' (or legacy '5A')
  else if (r.is_processed) review = 'processed';
  else review = 'pending';
  const name = [r.poc_firstname, r.poc_lastname].map((s) => (s || '').trim()).filter(Boolean).join(' ');
  return {
    id: r.id,
    leadType: r.lead_type || '',
    org: r.org || '',
    name,
    role: r.poc_role || '',
    email: r.email || '',
    speaker: r.speaker || '',
    event: r.event || '',
    subject: r.subject || '',
    source: r.source_table || '',
    foundAt: r.found_at,
    review,                                         // pending | send | skip | processed
    remark,
    reviewedBy: r.reviewed_by || null,
    reviewedAt: r.reviewed_at || null,
  };
}

export async function getAlternateLeads() {
  if (!supabaseConfigured()) {
    return { asOf: new Date().toISOString(), meta: { status: 'pending', source: SRC, note: 'Supabase not configured (set SUPABASE_DB_URL).' }, cards: {}, leads: [] };
  }
  const leads = (await q(SQL, [])).map(classify);
  const count = (f) => leads.filter(f).length;
  const total = leads.length;
  const pending = count((l) => l.review === 'pending');
  const send = count((l) => l.review === 'send');
  const skip = count((l) => l.review === 'skip');
  const decided = send + skip;
  const pendingLeads = leads.filter((l) => l.review === 'pending');
  return {
    asOf: new Date().toISOString(),
    meta: { status: 'live', source: SRC },
    cards: {
      total, pending, send, skip,
      sendRate: decided > 0 ? Math.round((send / decided) * 1000) / 10 : null,
      pendingOrgs: new Set(pendingLeads.map((l) => l.org).filter(Boolean)).size,
      pendingCold: pendingLeads.filter((l) => l.leadType === 'cold').length,
      pendingSocMed: pendingLeads.filter((l) => l.leadType === 'soc med').length,
      oldestPending: pendingLeads.length ? pendingLeads[pendingLeads.length - 1].foundAt : null,
    },
    leads,
  };
}

/** Set (decision 'send'|'skip') or reset (decision null) one lead's review. Returns the new remark. */
export async function setAlternateLeadReview(id, decision, by) {
  const remark = decision === 'send' ? REMARK_SEND : decision === 'skip' ? REMARK_SKIP : null;
  // Only touch leads that haven't been processed by the automation yet.
  const rows = await q(
    `UPDATE public.alternate_leads SET status = $2, sheet_remark = NULL WHERE id = $1 AND is_processed IS NULL RETURNING id`,
    [id, remark]
  );
  if (!rows.length) return null;
  await q(
    `INSERT INTO public.alternate_leads_review_log (lead_id, decision, action, set_by) VALUES ($1, $2, $3, $4)`,
    [id, remark, remark ? 'set' : 'reset', by]
  );
  return { id, remark, review: decision || 'pending', reviewedBy: remark ? by : null, reviewedAt: remark ? new Date().toISOString() : null };
}
