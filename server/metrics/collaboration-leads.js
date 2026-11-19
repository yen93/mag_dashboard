// Collaboration Leads — Marketing & PR collaboration review queue.
//
// Source: public.collaboration_leads (populated weekly by the find-collaborators Edge
// Function in marketing_pr_leads_finder). A lead is FOR REVIEW while outreach_status = 'new'.
// Reviewing writes `outreach_status` using the table's existing CHECK constraint values:
//   'approved' = Send intro (approved for outreach)
//   'rejected' = Skip (not pursued)
//   'new'      = Reset / pending review
// Leads already in downstream outreach ('contacted' | 'replied' | 'collaborated') are
// treated as processed and cannot be modified from this review queue.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC = 'Supabase → collaboration_leads';
export const STATUS_NEW = 'new';
export const STATUS_SEND = 'approved';
export const STATUS_SKIP = 'rejected';
export const LOG_SEND = 'Send intro';
export const LOG_SKIP = 'skip';

const EDITABLE_STATUSES = ['new', 'reviewing', 'approved', 'rejected', 'do_not_contact'];
const PROCESSED_STATUSES = new Set(['contacted', 'replied', 'collaborated']);

const SQL_WITH_LOG = `
  SELECT
    l.id, l.brand_name, l.brand_type, l.poc_name, l.poc_role,
    l.email, l.email_source, l.email_verified_on_source,
    l.website_url, l.rss_feed_url, l.source_url,
    l.platforms, l.platform_urls, l.region, l.niche, l.audience_notes,
    l.outreach_status, l.discovered_at, l.created_at,
    rv.set_by AS reviewed_by, rv.created_at AS reviewed_at
  FROM public.collaboration_leads l
  LEFT JOIN LATERAL (
    SELECT set_by, created_at FROM public.collaboration_leads_review_log g
    WHERE g.lead_id = l.id AND g.action = 'set' ORDER BY g.created_at DESC LIMIT 1
  ) rv ON TRUE
  ORDER BY COALESCE(l.discovered_at, l.created_at) DESC, l.brand_name ASC`;

const SQL_NO_LOG = `
  SELECT
    l.id, l.brand_name, l.brand_type, l.poc_name, l.poc_role,
    l.email, l.email_source, l.email_verified_on_source,
    l.website_url, l.rss_feed_url, l.source_url,
    l.platforms, l.platform_urls, l.region, l.niche, l.audience_notes,
    l.outreach_status, l.discovered_at, l.created_at,
    NULL::text AS reviewed_by, NULL::timestamptz AS reviewed_at
  FROM public.collaboration_leads l
  ORDER BY COALESCE(l.discovered_at, l.created_at) DESC, l.brand_name ASC`;

function classify(r) {
  const st = (r.outreach_status || 'new').trim().toLowerCase();
  const processed = PROCESSED_STATUSES.has(st);
  let review;
  if (st === STATUS_SEND || processed) review = 'send';
  else if (st === STATUS_SKIP || st === 'do_not_contact') review = 'skip';
  else review = 'pending'; // 'new' or 'reviewing'

  return {
    id: r.id,
    brandName: r.brand_name || '',
    brandType: r.brand_type || 'other',
    pocName: (r.poc_name || '').trim(),
    pocRole: (r.poc_role || '').trim(),
    email: r.email || '',
    emailSource: r.email_source || '',
    emailVerified: !!r.email_verified_on_source,
    websiteUrl: r.website_url || '',
    rssFeedUrl: r.rss_feed_url || '',
    sourceUrl: r.source_url || '',
    platforms: Array.isArray(r.platforms) ? r.platforms : [],
    platformUrls: (r.platform_urls && typeof r.platform_urls === 'object') ? r.platform_urls : {},
    region: r.region || '',
    niche: r.niche || '',
    audienceNotes: r.audience_notes || '',
    outreachStatus: st,
    discoveredAt: r.discovered_at || r.created_at,
    review,          // pending | send | skip
    processed,       // true once contacted / replied / collaborated (read-only)
    reviewedBy: r.reviewed_by || null,
    reviewedAt: r.reviewed_at || null,
  };
}

export async function getCollaborationLeads() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured (set SUPABASE_DB_URL).' },
      cards: {},
      leads: [],
    };
  }
  let rawRows;
  try {
    rawRows = await q(SQL_WITH_LOG, []);
  } catch (err) {
    // Graceful fallback if collaboration_leads_review_log migration hasn't been applied yet.
    if (err && err.code === '42P01') {
      rawRows = await q(SQL_NO_LOG, []);
    } else {
      throw err;
    }
  }
  const leads = rawRows.map(classify);
  const count = (f) => leads.filter(f).length;
  const total = leads.length;
  const pending = count((l) => !l.processed && l.review === 'pending');
  const send = count((l) => l.review === 'send');
  const skip = count((l) => !l.processed && l.review === 'skip');
  const decided = send + count((l) => l.review === 'skip');
  const pendingLeads = leads.filter((l) => !l.processed && l.review === 'pending');
  return {
    asOf: new Date().toISOString(),
    meta: { status: 'live', source: SRC },
    cards: {
      total,
      pending,
      send,
      skip,
      verifiedEmail: count((l) => !l.processed && l.emailVerified),
      pendingWithEmail: pendingLeads.filter((l) => l.emailVerified).length,
      sendRate: decided > 0 ? Math.round((send / decided) * 1000) / 10 : null,
      oldestPending: pendingLeads.length ? pendingLeads[pendingLeads.length - 1].discoveredAt : null,
    },
    leads,
  };
}

/** Set (decision 'send'|'skip') or reset (decision null) one collaboration lead's review. */
export async function setCollaborationLeadReview(id, decision, by) {
  const nextStatus = decision === 'send' ? STATUS_SEND : decision === 'skip' ? STATUS_SKIP : STATUS_NEW;
  const logged = decision === 'send' ? LOG_SEND : decision === 'skip' ? LOG_SKIP : null;

  const rows = await q(
    `UPDATE public.collaboration_leads
        SET outreach_status = $2
      WHERE id = $1
        AND outreach_status = ANY($3::text[])
      RETURNING id, outreach_status`,
    [id, nextStatus, EDITABLE_STATUSES]
  );
  if (!rows.length) return null;

  try {
    await q(
      `INSERT INTO public.collaboration_leads_review_log (lead_id, decision, action, set_by)
       VALUES ($1, $2, $3, $4)`,
      [id, logged, logged ? 'set' : 'reset', by]
    );
  } catch (err) {
    // Allow review updates to succeed even before the optional audit log migration is applied.
    if (!err || err.code !== '42P01') throw err;
  }

  return {
    id,
    outreachStatus: rows[0].outreach_status,
    review: decision || 'pending',
    reviewedBy: logged ? by : null,
    reviewedAt: logged ? new Date().toISOString() : null,
  };
}
