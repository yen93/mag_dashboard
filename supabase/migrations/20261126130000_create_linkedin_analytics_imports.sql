-- public.linkedin_analytics_imports — uploaded LinkedIn Analytics (.xlsx) exports
-- for James's LinkedIn (`james_linkedin`) and MAG LinkedIn (`mag_linkedin`).
-- ---------------------------------------------------------------------------
-- Backs the "Import LinkedIn Analytics" workflow on public/social_platforms.html.
-- LinkedIn's private analytics (impressions, members reached, daily engagement,
-- daily new followers, top posts with impressions/engagements, and audience
-- demographics) are not exposed to anonymous scrapers. Team members can export
-- LinkedIn's AggregateAnalytics_*.xlsx (or Page Analytics .xlsx) and upload it
-- directly from the Social Platforms page.
--
-- One row per platform_key (latest merged/imported state), UPSERT-ed on import.
-- An audit log table records each upload for traceability.

create table if not exists public.linkedin_analytics_imports (
  platform_key          text primary key,          -- 'james_linkedin' | 'mag_linkedin'
  file_name             text,
  date_start            date,
  date_end              date,
  date_range_label      text,
  total_followers       integer,
  total_followers_date  date,
  discovery             jsonb not null default '{}'::jsonb,       -- { impressions, membersReached, ... }
  daily_engagement      jsonb not null default '[]'::jsonb,       -- [{ date, impressions, engagements }]
  daily_followers       jsonb not null default '[]'::jsonb,       -- [{ date, newFollowers }]
  top_posts             jsonb not null default '[]'::jsonb,       -- [{ url, post, publishDate, impressions, engagements, engRate }]
  demographics          jsonb not null default '{}'::jsonb,       -- { seniority, industry, location, jobTitle, companySize, company }
  page_metrics          jsonb not null default '{}'::jsonb,       -- optional LinkedIn Page metrics (reactions, comments, reposts, pageViews, uniqueVisitors, customButtonClicks, searchAppearances)
  summary               jsonb not null default '{}'::jsonb,       -- import stats (row counts, detected sheets)
  uploaded_by           text,
  uploaded_at           timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.linkedin_analytics_imports enable row level security;

create table if not exists public.linkedin_analytics_import_log (
  id             bigserial primary key,
  platform_key   text not null,
  file_name      text,
  date_start     date,
  date_end       date,
  summary        jsonb not null default '{}'::jsonb,
  uploaded_by    text,
  uploaded_at    timestamptz not null default now()
);

create index if not exists linkedin_analytics_import_log_key_idx
  on public.linkedin_analytics_import_log (platform_key, uploaded_at desc);

alter table public.linkedin_analytics_import_log enable row level security;
