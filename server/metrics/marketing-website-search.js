// Marketing — Website & Search.
//
// Live figures for public/website_search.html. The ONLY website-traffic data in
// Supabase today is public.ga4_events_staging, which is a ROLLING ~60-day window
// of GA4 *conversion* events (form submits / opt-ins) — it holds NO pageview or
// session_start rows, so true "sessions" are not available here (they live in
// GA4 proper and would need a new sync). What we CAN serve live is website
// FORM ENQUIRIES and their source/medium split, computed at request time.
//
// Everything on the page that this module does not return (website sessions,
// organic search sessions, AI-tool visits, Google reviews, phone enquiries) is
// rendered as a "pending" chip by the page — no fabricated numbers.
//
// Enquiry = a real website form-submit event. We deliberately EXCLUDE
// free_gifts_opt_ins (lead-magnet opt-ins) and subscribe (newsletter), matching
// how the GA4 & Ads Leads page treats free_gifts_opt_ins as non-enquiries.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC =
  'Live (Supabase): website form enquiries from ga4_ac_contact_source\'s source ' +
  'table public.ga4_events_staging (GA4 form-submit events). Rolling ~60-day ' +
  'GA4 window — no session/pageview data is retained, so sessions are pending.';

// The GA4 event names that represent a genuine website enquiry form submission.
const ENQUIRY_EVENTS = [
  'form_submit',
  'Contact_Form_Submit_Alt',
  'form_submissions',
  'Form_submission_thankyou_1',
];

// Normalised medium bucket for a row (lower-cased; empty / (not set) → direct).
const MED = `
  CASE
    WHEN lower(coalesce(nullif(medium, ''), '')) = 'organic'              THEN 'organic'
    WHEN lower(coalesce(nullif(medium, ''), '')) = 'cpc'                  THEN 'cpc'
    WHEN lower(coalesce(nullif(medium, ''), '')) = 'referral'            THEN 'referral'
    WHEN lower(coalesce(nullif(medium, ''), '')) IN ('email', 'partner_email') THEN 'email'
    ELSE 'direct'
  END`;

const SQL = `
  WITH e AS (
    SELECT event_count, ${MED} AS med, event_time_utc
      FROM public.ga4_events_staging
      WHERE event_name = ANY($1)
  )
  SELECT
    coalesce(sum(event_count), 0)                                        AS total,
    coalesce(sum(event_count) FILTER (WHERE med = 'organic'), 0)         AS organic,
    coalesce(sum(event_count) FILTER (WHERE med = 'cpc'), 0)             AS cpc,
    coalesce(sum(event_count) FILTER (WHERE med = 'referral'), 0)        AS referral,
    coalesce(sum(event_count) FILTER (WHERE med = 'email'), 0)           AS email,
    coalesce(sum(event_count) FILTER (WHERE med = 'direct'), 0)          AS direct,
    to_char(min(event_time_utc), 'YYYY-MM-DD')                           AS "windowStart",
    to_char(max(event_time_utc), 'YYYY-MM-DD')                           AS "windowEnd"
  FROM e`;

export async function getWebsiteSearch() {
  if (!supabaseConfigured()) {
    return {
      enquiries: null,
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' },
    };
  }
  const n = (v) => Number(v) || 0;
  const [r] = await q(SQL, [ENQUIRY_EVENTS]);
  return {
    // Website form enquiries over the rolling GA4 window, split by medium.
    enquiries: {
      total: n(r.total),
      organic: n(r.organic),
      cpc: n(r.cpc),
      referral: n(r.referral),
      email: n(r.email),
      direct: n(r.direct),
    },
    window: { start: r.windowStart || null, end: r.windowEnd || null },
    meta: { status: 'live', source: SRC, note: null },
  };
}
