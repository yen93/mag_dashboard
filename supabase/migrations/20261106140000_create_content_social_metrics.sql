-- public.content_social_metrics — small key/value store for LOGIN-GATED content figures
-- that can't be scraped anonymously (LinkedIn newsletter subscriber count, article views).
-- ---------------------------------------------------------------------------
-- Each metric is ONE current figure, set either MANUALLY (read off the LinkedIn UI) or
-- by a cookie-authenticated Apify sync later — both UPSERT the same metric_key, so the
-- source can switch without schema changes. Backs the side cards on content_social.html.

create table if not exists public.content_social_metrics (
  metric_key  text primary key,   -- e.g. li_newsletter_subscribers_james
  label       text,               -- display label
  value       numeric,            -- the figure (null until first set)
  unit        text,               -- 'subscribers' / 'views' / …
  source      text,               -- 'manual' | 'apify-cookie'
  as_of       date,               -- when the figure was captured
  note        text,
  updated_at  timestamptz default now()
);

alter table public.content_social_metrics enable row level security;

-- Seed the newsletter-subscribers metric (value null until set manually or by the sync).
insert into public.content_social_metrics (metric_key, label, unit, source, note)
values (
  'li_newsletter_subscribers_james',
  'Newsletter subscribers',
  'subscribers',
  'manual',
  'Cas Tips for High Performers (James Castrission LinkedIn newsletter); subscriber count is login-gated, set manually or via a cookie-authenticated Apify actor.'
)
on conflict (metric_key) do nothing;
