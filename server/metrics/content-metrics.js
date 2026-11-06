// Marketing — Content & Social manual/login-gated metrics.
//
// Plain SELECT of public.content_social_metrics — a small key/value store for figures
// that can't be scraped anonymously (LinkedIn newsletter subscriber count, article
// views). Each is set manually (read off the LinkedIn UI) or by a cookie-authenticated
// Apify sync; both upsert the same metric_key. Backs the side cards on content_social.html.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC =
  'Live (Supabase): content_social_metrics — login-gated content figures (e.g. LinkedIn ' +
  'newsletter subscribers) set manually or by a cookie-authenticated Apify actor.';

export async function getContentMetrics() {
  if (!supabaseConfigured()) {
    return { data: {}, meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' } };
  }
  const rows = await q(
    `SELECT metric_key, label, value::float8 AS value, unit, source,
            to_char(as_of, 'YYYY-MM-DD') AS as_of
     FROM public.content_social_metrics`
  );
  const data = {};
  for (const r of rows) {
    data[r.metric_key] = {
      label: r.label,
      value: r.value == null ? null : Number(r.value),
      unit: r.unit,
      source: r.source,
      asOf: r.as_of,
    };
  }
  return { data, meta: { status: 'live', source: SRC, note: `${rows.length} metrics` } };
}
