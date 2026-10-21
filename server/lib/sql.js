// Shared SQL fragments.

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

// The single "is this contact-source row SHOWN on the GA4 & Ads Leads page?" rule,
// as a SQL boolean over an aliased `public.ga4_ac_contact_source cs` row. ROAS uses
// this so it counts EXACTLY the rows the page displays (hidden rows are never counted).
//
// KEEP IDENTICAL to the JS `isExcludedRow()` in BOTH public/ac_contact_sources.html
// and server/metrics/ac-contact-sources.js. A row is shown iff:
//   • it has a JC manual tag (always shown, bypasses the blacklist), OR
//   • it is not a free-gift opt-in AND not an excluded conversion link AND its
//     channel looks organic/cpc (contains "cpc" or "organic", case-insensitive).
// `google_ads_ac_field` deliberately does NOT affect visibility.
// Assumes the table is aliased `cs`.
export const CONTACT_SOURCE_SHOWN = `(
  cs.jc_manual_tag IS NOT NULL
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
