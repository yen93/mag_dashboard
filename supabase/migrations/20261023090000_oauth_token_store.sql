-- Rotating OAuth refresh-token store for background syncs.
-- Microsoft personal-account (MSA) refresh tokens are SINGLE-USE: each redemption invalidates
-- the previous token and returns a new one. A weekly job that only read a fixed secret would
-- therefore die after its first successful run. bing-ads-campaign-monthly-sync reads the latest
-- token here (seeding from the BING_ADS_REFRESH_TOKEN secret on first run), mints an access token,
-- and writes the rotated refresh token straight back each run.
--
-- To recover from a lock-out: mint a fresh refresh token, update the secret, then
--   delete from public.oauth_token_store where provider = 'bing_ads';
-- the next run re-seeds from the secret.
create table if not exists public.oauth_token_store (
  provider      text primary key,
  refresh_token text not null,
  updated_at    timestamptz not null default now()
);

comment on table public.oauth_token_store is
  'Rotating OAuth refresh tokens for background syncs (e.g. provider=bing_ads). Written only by edge functions via the service role; never exposed through PostgREST (RLS on, no policies).';

-- Service role bypasses RLS; with RLS enabled and no policies, anon/authenticated cannot read it.
alter table public.oauth_token_store enable row level security;
