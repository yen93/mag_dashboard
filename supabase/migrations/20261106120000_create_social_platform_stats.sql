-- public.social_platform_stats — weekly snapshots of each social platform's PUBLIC stats.
-- ---------------------------------------------------------------------------
-- Backs the "Platforms" table on public/content_social.html (Marketing → Content
-- & Social). One row per (platform_key, snapshot_date): a weekly snapshot of the
-- public follower count, recent post count, and per-post engagement scraped via
-- Apify by the apify-platforms-sync edge function.
--
-- SCOPE NOTE: Apify can only read PUBLIC data — followers, post counts, per-post
-- likes/comments/reactions. Impressions / reach are PRIVATE platform analytics
-- (Meta Business Suite, LinkedIn page analytics) and are deliberately NOT stored
-- here. The dashboard derives "Change" (follower delta vs the prior weekly
-- snapshot) at query time, so the table is an append-only weekly time series.
--
-- UPSERT-ONLY: reload_social_platform_stats() UPSERTS on the (platform_key,
-- snapshot_date) PK and NEVER deletes/truncates. Re-running within the same week
-- overwrites that week's row; a new week adds rows and keeps all prior snapshots.

create table if not exists public.social_platform_stats (
  platform_key             text not null,     -- mag_linkedin / mag_facebook / mag_instagram / james_linkedin
  platform_name            text,              -- display label (matches the page's platform names)
  network                  text,              -- linkedin / facebook / instagram
  profile_url              text,              -- the scraped profile/page URL
  snapshot_date            date not null,     -- the weekly run date (PK part)
  followers                integer,
  posts                    integer,           -- recent posts captured by the scrape
  total_engagement         integer,           -- sum of likes+comments+reactions over the captured posts
  avg_engagement_per_post  numeric,           -- total_engagement / posts
  engagement_rate          numeric,           -- avg_engagement_per_post / followers, as a percent
  raw                      jsonb,             -- normalized actor item(s), for debugging / future columns
  synced_at                timestamptz default now(),
  primary key (platform_key, snapshot_date)
);

create index if not exists social_platform_stats_key_date_idx
  on public.social_platform_stats (platform_key, snapshot_date desc);

-- Read-only to the dashboard's roles; the sync writes as the service role.
alter table public.social_platform_stats enable row level security;

-- reload_social_platform_stats(_rows jsonb)
-- _rows = a JSON array of one object per platform for THIS week's snapshot, built by
-- the apify-platforms-sync edge function. UPSERT-ONLY on (platform_key, snapshot_date)
-- — never deletes/truncates. An empty payload is refused so a failed/partial sync
-- never wipes the table (a platform missing this week simply keeps its last snapshot).
create or replace function public.reload_social_platform_stats(_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n int;
begin
  if _rows is null or jsonb_typeof(_rows) <> 'array' or jsonb_array_length(_rows) = 0 then
    raise exception 'reload_social_platform_stats: refusing to reload with empty payload';
  end if;

  insert into public.social_platform_stats (
    platform_key, platform_name, network, profile_url, snapshot_date,
    followers, posts, total_engagement, avg_engagement_per_post, engagement_rate,
    raw, synced_at)
  select
    r.platform_key, r.platform_name, r.network, r.profile_url, r.snapshot_date,
    r.followers, r.posts, r.total_engagement, r.avg_engagement_per_post, r.engagement_rate,
    coalesce(r.raw, '{}'::jsonb), now()
  from jsonb_to_recordset(_rows) as r(
    platform_key            text,
    platform_name           text,
    network                 text,
    profile_url             text,
    snapshot_date           date,
    followers               integer,
    posts                   integer,
    total_engagement        integer,
    avg_engagement_per_post numeric,
    engagement_rate         numeric,
    raw                     jsonb)
  where coalesce(r.platform_key, '') <> '' and r.snapshot_date is not null
  on conflict (platform_key, snapshot_date) do update set
    platform_name           = excluded.platform_name,
    network                 = excluded.network,
    profile_url             = excluded.profile_url,
    followers               = excluded.followers,
    posts                   = excluded.posts,
    total_engagement        = excluded.total_engagement,
    avg_engagement_per_post = excluded.avg_engagement_per_post,
    engagement_rate         = excluded.engagement_rate,
    raw                     = excluded.raw,
    synced_at               = excluded.synced_at;

  get diagnostics n = row_count;
  return n;
end;
$$;
