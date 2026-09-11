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

// Friendly labels for the leads.source_table provenance values.
export const LEAD_SOURCE_LABEL = {
  linkedin_posts: 'LinkedIn (outbound)',
  cold_leads_follow_up_sequence_threads: 'Cold outreach',
  follow_up_sequence_threads: 'Follow-up sequence',
  manually_found_leads: 'Manually found',
  unknown: 'Unknown',
};
