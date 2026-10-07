// New Paid Leads — per-contact acquisition source captured directly in
// ActiveCampaign.
//
// Reads a PRE-COMPUTED cache table, public.ac_new_leads, built by the
// new-paid-leads-sync edge function: every AC contact created OR last-updated
// on/after 5 Oct 2026 (PH) with its 11 "Src - *" custom fields (utm_*, gclid,
// msclkid, landing page, referrer, first-touch) captured at form-submit time. The
// dashboard does no AC calls at request time — it just SELECTs the table, so this
// stays fast. Plain SELECT → short cache is plenty.
//
// Sibling of ac-contact-sources.js (the historical "Historical Paid Leads
// Tracking" tab). That tab infers source via GA4 timestamp matching; this one
// reads the source captured directly on the contact, so there are no
// match/confidence columns — the real utm/gclid fields take their place.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'Calendly bookings (Supabase) ⟕ ActiveCampaign Src-* cache';

// Calendly bookings are the spine — one row per booking the calendly-source-sync
// edge function has seen (unique by email). Each booking carries a derived lead
// `channel` ('Google Ads', 'Microsoft Ads', 'Organic search', 'Unknown
// (no tracking)', …). public.ac_new_leads is LEFT-joined on the matched AC
// contact id to enrich the row with the Src-* fields captured on the contact
// (utm_*, gclid, landing page, first-touch) — null when the contact predates the
// 5 Oct 2026 cutoff and so isn't in that cache.
const SELECT = `
  SELECT
    b.booking_date      AS "bookingDate",
    b.name              AS "name",
    b.email             AS "email",
    b.channel           AS "channel",
    b.ac_contact_id     AS "contactId",
    b.domain            AS "domain",
    b.action            AS "action",
    b.ran_at            AS "ranAt",
    a.cdate             AS "cdate",
    a.udate             AS "udate",
    a.src_utm_source    AS "utmSource",
    a.src_utm_medium    AS "utmMedium",
    a.src_utm_campaign  AS "utmCampaign",
    a.src_utm_term      AS "utmTerm",
    a.src_gclid         AS "gclid",
    a.src_landing_page  AS "landingPage",
    a.src_ft_channel    AS "ftChannel"
  FROM public.calendly_src_sync_bookings b
  LEFT JOIN public.ac_new_leads a ON a.contact_id = b.ac_contact_id
  ORDER BY b.booking_date DESC NULLS LAST, b.ran_at DESC`;

// Same channel → bucket ladder the calendly-source-sync edge function uses, so
// the dashboard cards agree with the automation's own run totals.
const isPaidChannel = (c) => c === 'Google Ads' || c === 'Microsoft Ads';

export async function getNewPaidLeads() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      count: 0,
      rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
    };
  }

  const rows = await q(SELECT);
  const paid = rows.filter((r) => isPaidChannel(r.channel)).length;

  let status = 'live';
  let note = `${rows.length} Calendly bookings · ${paid} from paid ads.`;
  if (!rows.length) {
    status = 'pending';
    note = 'No Calendly bookings captured yet — the calendly-source-sync edge function fills this Mon–Fri 06:00 PH.';
  }

  return {
    asOf: new Date().toISOString(),
    count: rows.length,
    rows: section(rows, { source: SRC, status, note }),
  };
}
