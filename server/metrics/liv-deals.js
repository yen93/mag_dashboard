// LIV pipeline deals — a per-deal row list for the Sales page table.
//
// Pipeline "Keynotes // Workshops // Immersive (LIV)" = activecampaign_deals."group" = '3'.
// Scope: deals CREATED in 2026 (cdate in [2026-01-01, 2027-01-01)).
//
// 7 columns come straight from Supabase (date, account, contact, replied-from-stage,
// status, demo date, proposal sent). The other 6 (lead type, job title, last note +
// date, owner NAME, Magalog sent) live only in ActiveCampaign and are filled by
// enrichFromAC() when AC is configured. AC enrichment is best-effort: any failure or
// missing value leaves that cell null and the section is marked "partial" rather than
// failing the whole endpoint.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { acConfigured, acGetSafe, acPaginate, pMapLimit } from '../providers/activecampaign.js';
import { section } from '../lib/metric.js';

const SB = 'Supabase';
const AC = 'ActiveCampaign';
const GROUP_ID = '3';

// "Replied back to us" = Yes for any reply or downstream stage; No only for
// 71 (CONTACT MADE – NO REPLY) and any pre-contact/foreign/unknown stage.
const YES_STAGES = ['70', '69', '58', '59', '15', '121', '113', '12'];

// AC CONTACT custom field ids (confirmed from the live field schema). These
// are used as a fallback when there is no equivalent DEAL-level field resolved
// from dealCustomFieldMeta: 39 = "Inbound/Outbound Check" (lead type),
// 35 = "Magalog sent?".
const LEADTYPE_CONTACT_FIELD = '39';
const MAGALOG_CONTACT_FIELD = '35';

const AC_CONCURRENCY = 6; // AC allows ~5 req/s; provider retries on 429

const BASE_SQL = `
  SELECT
    d.id,
    d.cdate                                                          AS date_created,
    COALESCE(a.name, NULLIF(TRIM(split_part(d.title, '//', 1)), '')) AS account,
    d.account                                                        AS account_id,
    d.contact                                                        AS contact_id,
    NULLIF(TRIM(concat_ws(' ', c."firstName", c."lastName")), '')    AS primary_contact,
    d.owner                                                          AS owner_ac_id,
    d.stage                                                          AS stage,
    CASE WHEN d.stage = ANY($2) THEN 'Yes' ELSE 'No' END             AS replied,
    CASE d.status WHEN 0 THEN 'open' WHEN 1 THEN 'won'
                  WHEN 2 THEN 'lost' ELSE 'other' END                AS deal_status,
    cf.demo_date                                                     AS demo_date,
    cf.proposal_sent                                                 AS proposal_sent
  FROM activecampaign_deals d
  LEFT JOIN activecampaign_accounts a ON a.id = d.account
  LEFT JOIN activecampaign_contacts c ON c.id = d.contact
  LEFT JOIN LATERAL (
    SELECT demo_date, proposal_sent
    FROM ac_custom_fields
    WHERE deal_id = d.id
    ORDER BY created_at DESC
    LIMIT 1
  ) cf ON true
  WHERE d."group" = $1
    AND d.cdate >= '2026-01-01' AND d.cdate < '2027-01-01'
  ORDER BY d.cdate DESC`;

export async function getLivDeals() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      count: 0,
      deals: section([], { source: SB, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
    };
  }

  const rows = await q(BASE_SQL, [GROUP_ID, YES_STAGES]);
  const deals = rows.map((r) => ({
    id: r.id,
    dateCreated: r.date_created,
    account: r.account,
    accountId: r.account_id,
    leadType: null, // AC
    contact: r.primary_contact,
    contactId: r.contact_id,
    jobTitle: null, // AC
    lastNote: null, // AC
    lastNoteDate: null, // AC
    owner: r.owner_ac_id ? String(r.owner_ac_id) : null, // AC replaces id with name
    replied: r.replied,
    status: r.deal_status,
    demoDate: r.demo_date,
    proposalSent: r.proposal_sent,
    magalogSent: null, // AC
  }));

  let status = 'live';
  let note = 'Pipeline: Keynotes // Workshops // Immersive (LIV) · deals created in 2026';

  if (acConfigured()) {
    try {
      await enrichFromAC(deals);
    } catch (err) {
      console.warn('[liv-deals] AC enrichment failed:', err.message);
      status = 'partial';
      note = 'ActiveCampaign enrichment failed; showing Supabase columns only.';
    }
  } else if (deals.length) {
    status = 'partial';
    note = 'ActiveCampaign not connected — lead type, job title, notes, owner name and Magalog columns are unavailable (set AC_API_URL / AC_API_KEY).';
  }

  return {
    asOf: new Date().toISOString(),
    count: deals.length,
    deals: section(deals, { source: status === 'live' ? `${SB} + ${AC}` : SB, status, note }),
  };
}

// ---- ActiveCampaign enrichment -------------------------------------------

async function enrichFromAC(deals) {
  if (!deals.length) return;

  // 1. Owner id -> name
  const users = await acPaginate('users', 'users', {}, { pageSize: 100, max: 500 });
  const ownerMap = {};
  for (const u of users) ownerMap[String(u.id)] = fullName(u) || u.username || u.email || String(u.id);
  for (const d of deals) if (d.owner) d.owner = ownerMap[d.owner] || d.owner;

  // 2. Resolve DEAL custom field ids by label
  const meta = await acPaginate('dealCustomFieldMeta', 'dealCustomFieldMeta', {}, { pageSize: 100, max: 500 });
  const fieldId = matchFields(meta);

  // 3. Per-deal: custom field values + latest note (fail-soft per deal). AC's
  //    single-deal ?include= does not sideload, so we hit the two sub-resource
  //    endpoints (confirmed present on deals.links) directly.
  await pMapLimit(deals, AC_CONCURRENCY, async (d) => {
    const cdRes = await acGetSafe(`deals/${d.id}/dealCustomFieldData`, { limit: 100 });
    const cfd = cdRes && Array.isArray(cdRes.dealCustomFieldData) ? cdRes.dealCustomFieldData : [];
    const byField = {};
    for (const v of cfd) {
      const k = String(v.customFieldId ?? v.dealCustomFieldMetumId ?? v.custom_field_id ?? '');
      if (k) byField[k] = v.fieldValue;
    }
    if (fieldId.leadType) d.leadType = cleanValue(byField[fieldId.leadType]);
    if (fieldId.jobTitle) d.jobTitle = cleanValue(byField[fieldId.jobTitle]);
    if (fieldId.magalog) d.magalogSent = cleanValue(byField[fieldId.magalog]);

    const nRes = await acGetSafe(`deals/${d.id}/notes`);
    const notes = nRes && Array.isArray(nRes.notes) ? nRes.notes : [];
    const latest = pickLatestNote(notes);
    if (latest) {
      d.lastNote = stripHtml(latest.note);
      d.lastNoteDate = latest.cdate || latest.mdate || null;
    }
  });

  // 4. CONTACT-level fallback for fields that aren't deal fields. Lead type and
  //    Magalog live on the contact in this account, so unless a deal field with
  //    the same label was found above, read them in bulk from fieldValues.
  const fallbacks = [];
  if (!fieldId.leadType) fallbacks.push({ prop: 'leadType', field: LEADTYPE_CONTACT_FIELD });
  if (!fieldId.magalog) fallbacks.push({ prop: 'magalogSent', field: MAGALOG_CONTACT_FIELD });
  for (const fb of fallbacks) {
    const fvals = await acPaginate('fieldValues', 'fieldValues', { 'filters[fieldid]': fb.field }, { pageSize: 100, max: 20000 });
    const byContact = {};
    for (const fv of fvals) byContact[String(fv.contact)] = fv.value;
    for (const d of deals) {
      if (d[fb.prop] == null && d.contactId && byContact[String(d.contactId)] != null) {
        d[fb.prop] = cleanValue(byContact[String(d.contactId)]);
      }
    }
  }

  // 5. Job title is AC's native account<->contact association field
  //    (accountContacts.jobTitle) — the value shown under "Account" in a
  //    contact's General Details. It is neither a contact nor a deal custom
  //    field, so fetch the associations once and map them onto each deal by
  //    contact, preferring the association for the deal's own account when a
  //    contact is linked to more than one account.
  if (deals.some((d) => d.jobTitle == null && d.contactId)) {
    const links = await acPaginate('accountContacts', 'accountContacts', {}, { pageSize: 100, max: 20000 });
    const byContactAccount = {}; // "contact:account" -> job title
    const byContactAny = {};     // contact -> first non-empty job title
    for (const l of links) {
      const title = cleanValue(l.jobTitle);
      if (!title) continue;
      const c = String(l.contact);
      byContactAccount[c + ':' + String(l.account)] = title;
      if (byContactAny[c] == null) byContactAny[c] = title;
    }
    for (const d of deals) {
      if (d.jobTitle != null || !d.contactId) continue;
      const c = String(d.contactId);
      d.jobTitle =
        (d.accountId != null && byContactAccount[c + ':' + String(d.accountId)]) ||
        byContactAny[c] ||
        null;
    }
  }
}

// ---- helpers --------------------------------------------------------------

function fullName(u) {
  return [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
}

// Match deal-field labels to the columns we need.
function matchFields(meta) {
  const out = { leadType: null, jobTitle: null, magalog: null };
  for (const m of meta) {
    const label = String(m.fieldLabel || m.label || '').toLowerCase();
    const id = String(m.id);
    if (!out.leadType && (label.includes('inbound') || label.includes('outbound'))) out.leadType = id;
    if (!out.jobTitle && label.includes('job title')) out.jobTitle = id;
    if (!out.magalog && label.includes('magalog')) out.magalog = id;
  }
  return out;
}

// AC multi-select values are wrapped/joined with "||"; normalise to a plain string.
function cleanValue(v) {
  if (v == null) return null;
  let s = String(v).replace(/\|+/g, ', ').replace(/^,\s*|,\s*$/g, '').trim();
  return s || null;
}

function stripHtml(v) {
  if (v == null) return null;
  const s = String(v).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
}

function pickLatestNote(notes) {
  if (!Array.isArray(notes) || !notes.length) return null;
  return notes
    .filter((n) => n && (n.note != null))
    .sort((a, b) => new Date(b.cdate || b.mdate || 0) - new Date(a.cdate || a.mdate || 0))[0] || null;
}
