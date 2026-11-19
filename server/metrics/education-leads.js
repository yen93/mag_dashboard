// Education Leads — Liv's review queue for the org-level education prospects the
// discovery finder scrapes (replaces the old "Liv's Remark" column in the
// ai_scraped_educ_leads Google Sheet).
//
// Source: public.auto_found_educ_leads (plain SELECT). A lead is FOR REVIEW while
// status = 'new' (the finder's default). Reviewing writes `status`:
//   'Send intro' = approved for outreach · 'skip' = not pursued · 'new' = reset/for-review.
// The daily discovery run only upserts BRAND-NEW orgs (it dedups against existing
// org_name_norm), so a review written here is never overwritten.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC = 'Supabase → auto_found_educ_leads';
export const REMARK_SEND = 'Send intro';
export const REMARK_SKIP = 'skip';

// Only surface leads that have been enriched with a point of contact (poc_*). An org
// with no POC yet isn't ready to review, so it's excluded entirely.
const POC_PRESENT =
  `coalesce(nullif(btrim(l.poc_firstname),''), nullif(btrim(l.poc_lastname),''), nullif(btrim(l.poc_role),'')) is not null`;

const SQL = `
  SELECT
    l.id, l.org_name, l.school_or_association, l.country, l.region, l.website,
    l.domain, l.category, l.sector, l.status,
    l.poc_firstname, l.poc_lastname, l.poc_role,
    COALESCE(l.created_at, l.updated_at) AS found_at,
    rv.set_by AS reviewed_by, rv.created_at AS reviewed_at
  FROM public.auto_found_educ_leads l
  LEFT JOIN LATERAL (
    SELECT set_by, created_at FROM public.auto_found_educ_leads_review_log g
    WHERE g.lead_id = l.id AND g.action = 'set' ORDER BY g.created_at DESC LIMIT 1
  ) rv ON TRUE
  WHERE ${POC_PRESENT}
  ORDER BY COALESCE(l.created_at, l.updated_at) DESC, l.id DESC`;

function classify(r) {
  const st = (r.status || '').trim();
  let review;
  if (st.toLowerCase() === REMARK_SEND.toLowerCase()) review = 'send';
  else if (st && st.toLowerCase() !== 'new') review = 'skip';   // any non-'new', non-'Send intro' value = skipped
  else review = 'pending';
  const pocName = [r.poc_firstname, r.poc_lastname].map((s) => (s || '').trim()).filter(Boolean).join(' ');
  return {
    id: r.id,
    org: r.org_name || '',
    kind: (r.school_or_association || '').trim().toLowerCase() || 'unknown',  // 'school' | 'association'
    country: r.country || '',
    region: r.region || '',
    website: r.website || '',
    domain: r.domain || '',
    category: r.category || '',
    sector: r.sector || '',
    pocName,
    pocRole: (r.poc_role || '').trim(),
    foundAt: r.found_at,
    review,                                           // pending | send | skip (tag, for pills)
    reviewedBy: r.reviewed_by || null,
    reviewedAt: r.reviewed_at || null,
  };
}

export async function getEducationLeads() {
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
      schools: leads.filter((l) => l.kind === 'school').length,
      associations: leads.filter((l) => l.kind === 'association').length,
      pendingRegions: new Set(pendingLeads.map((l) => l.region).filter(Boolean)).size,
      oldestPending: pendingLeads.length ? pendingLeads[pendingLeads.length - 1].foundAt : null,
    },
    leads,
  };
}

/** Set (decision 'send'|'skip') or reset (decision null) one lead's review. Returns the new state. */
export async function setEducationLeadReview(id, decision, by) {
  // status is NOT NULL on auto_found_educ_leads; a reset restores the finder's default 'new'.
  const status = decision === 'send' ? REMARK_SEND : decision === 'skip' ? REMARK_SKIP : 'new';
  const logged = decision === 'send' ? REMARK_SEND : decision === 'skip' ? REMARK_SKIP : null;
  const rows = await q(
    `UPDATE public.auto_found_educ_leads SET status = $2, updated_at = now() WHERE id = $1 RETURNING id`,
    [id, status]
  );
  if (!rows.length) return null;
  await q(
    `INSERT INTO public.auto_found_educ_leads_review_log (lead_id, decision, action, set_by) VALUES ($1, $2, $3, $4)`,
    [id, logged, logged ? 'set' : 'reset', by]
  );
  return { id, review: decision || 'pending', reviewedBy: logged ? by : null, reviewedAt: logged ? new Date().toISOString() : null };
}
