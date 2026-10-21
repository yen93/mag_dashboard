-- JC manual-review tagging for the GA4 & Ads Leads page.
--
-- Lets James (JC) / admins mark the "Google Ads?=Yes but no channel & no tag" rows
-- on public.ga4_ac_contact_source as "Could be SEO or Paid Ad" (or review them as
-- NOT paid/SEO). The decision must survive the daily rebuild: cs.jc_manual_tag is
-- auto-filled by the trg_ga4cs_jc_manual_tag trigger from
-- mag_gads_direct_inbound_lead_source.jc_final_attr by deal_id, and the batch jobs
-- (rebuild_ga4_ac_matches / update_ga4_contact_deals) rewrite deal_id regularly,
-- re-firing that trigger — so a value written straight into jc_manual_tag would be
-- clobbered. Instead the manual decision lives here and the read path (the dashboard
-- SELECT in server/metrics/ac-contact-sources.js) prefers it. The existing trigger
-- and batch functions are intentionally left untouched.
--
-- DISPLAY-ONLY: this override feeds the GA4 & Ads Leads page, NOT ROAS. roas.js counts
-- via CONTACT_SOURCE_SHOWN (server/lib/sql.js), which reads the base cs.jc_manual_tag,
-- not this table — consistent with the deliberate display-vs-ROAS divergence.

-- Current decision per contact (source of truth for a MANUAL tag; read-coalesced).
-- Presence of a row == "reviewed". decision NULL == reviewed, not paid/SEO.
create table if not exists public.ga4cs_jc_manual_review (
  contact_id text primary key,
  decision   text,
  set_by     text not null,
  updated_at timestamptz not null default now()
);

-- Append-only audit history ("this approval system should then be logged in DB").
create table if not exists public.ga4cs_jc_manual_review_log (
  id         bigint generated always as identity primary key,
  contact_id text not null,
  decision   text,
  set_by     text not null,
  created_at timestamptz not null default now()
);

create index if not exists ga4cs_jc_review_log_contact_idx
  on public.ga4cs_jc_manual_review_log (contact_id, created_at desc);
