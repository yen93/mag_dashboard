-- Instagram "What works best, by type" cache (Social Platforms tab).
--
-- A tiny snapshot of average per-post REACH + engagement by content format (Reel/Video,
-- Carousel, Image) across recent Instagram posts. Computing it needs one Graph "reach" call
-- PER post (~24 calls), so the dashboard server refreshes this at most once a day (a staleness
-- gate in server/metrics/meta-ig-by-type.js) rather than on every page view. The Meta Graph
-- API itself is free; the daily gate just keeps the call volume + latency down.
--
-- UPSERT-ONLY, never truncated: each daily refresh upserts the current formats (one row per
-- media_label) with a fresh captured_at; the reader returns only the latest snapshot
-- (where captured_at = max(captured_at)), so a format absent on a given day is simply not
-- shown — no row is ever deleted.
create table if not exists public.meta_ig_by_type (
  media_label     text primary key,
  post_count      integer not null default 0,
  avg_reach       numeric,
  avg_engagement  numeric,
  captured_at     timestamptz not null default now()
);

alter table public.meta_ig_by_type enable row level security;
-- No policies: the dashboard server reads/writes via the pooled owner connection, never the
-- anon/authenticated PostgREST roles (same pattern as public.meta_ig_monthly).
