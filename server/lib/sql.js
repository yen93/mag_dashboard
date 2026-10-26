// Shared SQL fragments.

// USD→AUD conversion rate, for displaying activecampaign_deals.value (stored in CENTS,
// with a mixed-case `currency` that is mostly 'aud' but occasionally 'usd') as AUD
// dollars. Mid-market rate fetched 2026-10-26 (Valuta/Xe/MSN/Wise clustered ~1.422–1.425).
// Single source of truth — ROAS (roas.js / roas-deals.js) and the GA4 & Ads Leads page
// (ac-contact-sources.js) all derive their displayed deal value from `acValueAud()` so the
// numbers match exactly. Update this one constant when the rate drifts materially.
export const USD_AUD_RATE = 1.4227;

// SQL expression: an `public.activecampaign_deals` row aliased `<alias>` → its value in
// AUD dollars (cents / 100, USD converted at USD_AUD_RATE). NULL when the row is absent
// (deliberately no fallback — a blank means the activecampaign_deals daily sync broke).
export function acValueAud(alias = 'ad') {
  return (
    `round((${alias}.value / 100.0) * ` +
    `CASE WHEN lower(coalesce(${alias}.currency, '')) = 'usd' THEN ${USD_AUD_RATE} ELSE 1 END, 2)`
  );
}

// Buckets the free-text lead-source/program taxonomy that MAG encodes in the
// deal title after "//" (e.g. "Acme // Keynote"). `s` must be the lowercased,
// trimmed suffix. Kept in one place so Sales/Marketing/Operations agree.
export const SOURCE_BUCKET = `
  CASE
    WHEN s ~ 'keynote' AND s ~ 'post' THEN 'Post-keynote'
    WHEN s ~ 'keynote' THEN 'Keynote'
    WHEN s ~ 'immersive|uncharted ice' THEN 'Immersive'
    WHEN s ~ 'exec x' THEN 'Exec X'
    WHEN s ~ 'social media' THEN 'Social media'
    WHEN s ~ 'cold' THEN 'Cold outreach'
    WHEN s ~ 'industry' THEN 'Industry-based'
    WHEN s ~ 'prior|previously' THEN 'Prior/lost lead'
    WHEN s = '' OR s IS NULL THEN 'Unknown'
    ELSE 'Other'
  END`;

// The "which contact-source rows does ROAS count?" rule, as a SQL boolean over an
// aliased `public.ga4_ac_contact_source cs` row. A row is counted iff:
//   • it has an EFFECTIVE JC tag (always counted, bypasses the blacklist), OR
//   • it is not a free-gift opt-in AND not an excluded conversion link AND its
//     channel looks organic/cpc (contains "cpc" or "organic", case-insensitive).
//
// EFFECTIVE JC tag = a JC manual-review override (public.ga4cs_jc_manual_review,
// decision e.g. "Could be SEO or Paid Ad") WINS over the auto-derived cs.jc_manual_tag,
// mirroring the display. So a JC-tagged "Google Ads?"=Yes row (channel still NULL) now
// FEEDS ROAS, and a row JC reviewed as "Not paid ad / SEO" (override decision NULL) does
// not. **Consumers MUST `LEFT JOIN public.ga4cs_jc_manual_review r ON r.contact_id =
// cs.contact_id`** (alias `r`) — this predicate references `r`.
//
// DELIBERATE DIVERGENCE from the page's JS `isExcludedRow()` in
// public/ac_contact_sources.html and server/metrics/ac-contact-sources.js: those two
// display copies ALSO show rows flagged `google_ads_ac_field='Yes'` (AC "Google Ads?"=Yes
// even with no GA4 channel). This predicate intentionally OMITS that branch, so an
// untagged "Google Ads?"=Yes row is still NOT counted — do NOT add a google_ads_ac_field
// branch here to "re-sync" the copies. Assumes the table is aliased `cs` (+ override `r`).
export const CONTACT_SOURCE_SHOWN = `(
  (CASE WHEN r.contact_id IS NOT NULL THEN r.decision ELSE cs.jc_manual_tag END) IS NOT NULL
  OR (
    lower(coalesce(cs.conversion_action, '')) <> 'free_gifts_opt_ins'
    AND (
      '/' || trim(both '/' from regexp_replace(
        regexp_replace(lower(coalesce(cs.conversion_link, '')), '^https?://[^/]+', ''),
        '[?#[:space:]].*$', ''
      )) || '/'
    ) NOT IN (
      '/careers-seasonal/', '/executive-x/', '/careersph-based/', '/free-gift-opt-in/',
      '/leader-x-payment-gateway/', '/execx/', '/executive-x-payment-gateway/'
    )
    AND cs.channel ~* 'cpc|organic'
  )
)`;

// Friendly labels for the leads.source_table provenance values.
export const LEAD_SOURCE_LABEL = {
  linkedin_posts: 'LinkedIn (outbound)',
  cold_leads_follow_up_sequence_threads: 'Cold outreach',
  follow_up_sequence_threads: 'Follow-up sequence',
  manually_found_leads: 'Manually found',
  unknown: 'Unknown',
};
