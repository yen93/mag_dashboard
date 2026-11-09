-- Schedule the post_conference_deals cache rebuild. Runs 06:30 AM Philippine
-- Time daily (22:30 UTC) — AFTER the deal mirror (activecampaign-deals-sync,
-- 05:00 PH), the contacts mirror (activecampaign-contacts-sync, 05:30 PH) and
-- the indirect-deals sync (ac-indirect-deals-sync, 06:15 PH) have refreshed, so
-- the rebuild joins against fresh deal/contact/account rows.
--
-- Unlike the AC-field-based caches, this needs NO edge function / REST call:
-- pipeline membership is already on the local mirror, so pg_cron invokes the
-- rebuild RPC directly. reload_post_conference_deals() is UPSERT-ONLY, so even
-- an empty/stale mirror can never wipe the cache.

select cron.schedule(
  'post-conference-deals-sync-daily',
  '30 22 * * *',
  $$ select public.reload_post_conference_deals(); $$
);
