-- public.meta_fb_audience_import — uploaded Facebook Page "Audience" CSV export.
-- ---------------------------------------------------------------------------
-- Backs the "Audience — who follows us" import on the Facebook tab of
-- public/social_platforms.html. Facebook Page follower demographics
-- (page_fans_gender_age / _city / _country) were RETIRED by Meta's New-Pages API
-- with no Graph API replacement (verified live 2026-11-27 — every metric returns
-- "(#100) must be a valid insights metric"). So, like the LinkedIn Analytics import,
-- a team member exports the Audience CSV from Meta Business Suite and uploads it here.
--
-- Singleton: one row for the MAG Facebook Page, UPSERT-ed on each import (never
-- truncated). An audit log records each upload.

create table if not exists public.meta_fb_audience_import (
  page_key     text primary key default 'mag_facebook',
  file_name    text,
  age_gender   jsonb not null default '[]'::jsonb,   -- [{ age, female, male }]  (% of audience)
  locations    jsonb not null default '[]'::jsonb,   -- [{ place, share }]       top cities, % share
  countries    jsonb not null default '[]'::jsonb,   -- [{ place, share }]       top countries, % share
  uploaded_by  text,
  uploaded_at  timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.meta_fb_audience_import enable row level security;
-- No policies: the dashboard server reads/writes via the pooled owner connection only
-- (same pattern as public.linkedin_analytics_imports / public.meta_ig_monthly).

create table if not exists public.meta_fb_audience_import_log (
  id           bigserial primary key,
  page_key     text not null,
  file_name    text,
  uploaded_by  text,
  uploaded_at  timestamptz not null default now()
);

alter table public.meta_fb_audience_import_log enable row level security;
