// Instagram Leads — Sales review queue for AI-extracted speaker Instagram Story leads
// (replaces manual Remark triage in the ai_scraped_insta_stories Google Sheet).
//
// Source: public.insta_stories (rows where org IS NOT NULL AND poc IS NOT NULL).
// A lead is FOR REVIEW while org IS NOT NULL AND sheet_remark IS NULL AND outreach_status IS NULL.
// Reviewing from the dashboard writes `outreach_status`:
//   'Send intro' = approved for outreach
//   'skip'       = not pursued
//   NULL         = reset / back to pending review
//
// Legacy rows already triaged in the Google Sheet carry `sheet_remark` ('Send intro' or '5A')
// and are surfaced read-only under the Send intro / Skipped filters (never overwritten).
// Leads whose `outreach_status` has progressed past review (e.g. 'sent', 'contacted',
// 'replied', 'processed') are treated as processed and locked read-only.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC = 'Supabase → insta_stories';
export const REMARK_SEND = 'Send intro';
export const REMARK_SKIP = 'skip';

const SQL_WITH_LOG = `
  SELECT
    l.id, l.created_at, l.speaker, l.insta_handle, l.org, l.event_name,
    l.poc, l.poc_email, l.poc_position, l.description,
    l.saved_img_link, l.status, l.is_added_to_sheet, l.enrichment_is_processed,
    l.sheet_remark, l.outreach_status,
    rv.set_by AS reviewed_by, rv.created_at AS reviewed_at
  FROM public.insta_stories l
  LEFT JOIN LATERAL (
    SELECT set_by, created_at FROM public.insta_stories_review_log g
    WHERE g.lead_id = l.id AND g.action = 'set' ORDER BY g.created_at DESC LIMIT 1
  ) rv ON TRUE
  WHERE l.org IS NOT NULL AND l.poc IS NOT NULL
  ORDER BY l.created_at DESC, l.id DESC`;

const SQL_NO_LOG = `
  SELECT
    l.id, l.created_at, l.speaker, l.insta_handle, l.org, l.event_name,
    l.poc, l.poc_email, l.poc_position, l.description,
    l.saved_img_link, l.status, l.is_added_to_sheet, l.enrichment_is_processed,
    l.sheet_remark, l.outreach_status,
    NULL::text AS reviewed_by, NULL::timestamptz AS reviewed_at
  FROM public.insta_stories l
  WHERE l.org IS NOT NULL AND l.poc IS NOT NULL
  ORDER BY l.created_at DESC, l.id DESC`;

function classify(r) {
  const outreach = (r.outreach_status || '').trim();
  const outreachLow = outreach.toLowerCase();
  const sheet = (r.sheet_remark || '').trim();
  const sheetLow = sheet.toLowerCase();

  const isReviewTag = outreachLow === REMARK_SEND.toLowerCase() || outreachLow === REMARK_SKIP.toLowerCase();
  // Downstream outreach automation moved this row beyond the Send intro / Skip review state.
  const processed = Boolean(outreach && !isReviewTag);
  // Historical row already triaged in the ai_scraped_insta_stories Google Sheet.
  const fromSheet = Boolean(!outreach && sheet);

  let review;
  if (processed) {
    review = 'send';
  } else if (outreach) {
    review = outreachLow === REMARK_SEND.toLowerCase() ? 'send' : 'skip';
  } else if (sheet) {
    review = sheetLow === REMARK_SEND.toLowerCase() ? 'send' : 'skip'; // 'Send intro' vs '5A'
  } else {
    review = 'pending';
  }

  return {
    id: r.id,
    createdAt: r.created_at,
    speaker: (r.speaker || '').trim(),
    instaHandle: (r.insta_handle || '').trim().replace(/^@+/, ''),
    org: (r.org || '').trim(),
    eventName: (r.event_name || '').trim(),
    poc: (r.poc || '').trim(),
    pocEmail: (r.poc_email || '').trim(),
    pocPosition: (r.poc_position || '').trim(),
    description: (r.description || '').trim(),
    savedImgLink: (r.saved_img_link || '').trim(),
    enriched: !!r.enrichment_is_processed,
    addedToSheet: !!r.is_added_to_sheet,
    sheetRemark: sheet,
    outreachStatus: outreach,
    review,                                         // pending | send | skip
    processed,                                      // true once downstream outreach moved status past review
    fromSheet,                                      // true for legacy Google Sheet backfilled decisions
    inQueue: !processed && !fromSheet,              // active dashboard review queue (pending + newly tagged)
    reviewedBy: r.reviewed_by || null,
    reviewedAt: r.reviewed_at || null,
  };
}

export async function getInstaLeads() {
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
    // Graceful fallback if insta_stories_review_log migration hasn't been applied yet.
    if (err && err.code === '42P01') {
      rawRows = await q(SQL_NO_LOG, []);
    } else {
      throw err;
    }
  }
  const leads = rawRows.map(classify);
  const count = (f) => leads.filter(f).length;
  const total = leads.length;
  const pendingLeads = leads.filter((l) => l.inQueue && l.review === 'pending');
  const queueLeads = leads.filter((l) => l.inQueue);
  const pending = pendingLeads.length;
  const send = count((l) => l.review === 'send');
  const skip = count((l) => l.review === 'skip');
  const decided = send + skip;
  return {
    asOf: new Date().toISOString(),
    meta: { status: 'live', source: SRC },
    cards: {
      total,
      pending,
      send,
      skip,
      sendRate: decided > 0 ? Math.round((send / decided) * 1000) / 10 : null,
      pendingOrgs: new Set(pendingLeads.map((l) => l.org.toLowerCase()).filter(Boolean)).size,
      pendingSpeakers: new Set(pendingLeads.map((l) => l.speaker.toLowerCase()).filter(Boolean)).size,
      queueWithContact: queueLeads.filter((l) => l.poc || l.pocEmail).length,
      queueEnriched: queueLeads.filter((l) => l.enriched).length,
      oldestPending: pendingLeads.length ? pendingLeads[pendingLeads.length - 1].createdAt : null,
    },
    leads,
  };
}

/** Set (decision 'send'|'skip') or reset (decision null) one Instagram Story lead's review. */
export async function setInstaLeadReview(id, decision, by) {
  const nextStatus = decision === 'send' ? REMARK_SEND : decision === 'skip' ? REMARK_SKIP : null;

  // Only allow tagging leads with an org that weren't already triaged on the legacy sheet
  // and haven't progressed into downstream outreach.
  const rows = await q(
    `UPDATE public.insta_stories
        SET outreach_status = $2
      WHERE id = $1
        AND org IS NOT NULL
        AND sheet_remark IS NULL
        AND (outreach_status IS NULL OR lower(btrim(outreach_status)) IN ('send intro', 'skip'))
      RETURNING id, outreach_status`,
    [id, nextStatus]
  );
  if (!rows.length) return null;

  try {
    await q(
      `INSERT INTO public.insta_stories_review_log (lead_id, decision, action, set_by)
       VALUES ($1, $2, $3, $4)`,
      [id, nextStatus, nextStatus ? 'set' : 'reset', by]
    );
  } catch (err) {
    // Allow review updates to succeed even before the optional audit log migration is applied.
    if (!err || err.code !== '42P01') throw err;
  }

  return {
    id,
    outreachStatus: rows[0].outreach_status || '',
    review: decision || 'pending',
    reviewedBy: nextStatus ? by : null,
    reviewedAt: nextStatus ? new Date().toISOString() : null,
  };
}
