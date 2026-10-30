-- Monthly schedule for xero-channel-summary-sync (ROI tab Channel Summary chart).
-- 2nd of the month, 22:00 UTC = 3rd 06:00 Philippine Time — a few days into the new month
-- so the prior month's card/direct-debit charges are reconciled in Xero. The function is
-- deployed --no-verify-jwt, so the POST carries no Authorization header. It reads Xero
-- SPEND bank transactions on the marketing accounts, categorises them via
-- public.marketing_channel_vendor_map, and wipe-then-reinserts public.marketing_channel_monthly.
-- Running monthly also keeps the Xero refresh token (public.oauth_token_store, provider='xero')
-- alive. 150s pg_net timeout covers the paginated reads (~2900 bank txns).
select cron.unschedule('xero-channel-summary-sync-monthly')
where exists (select 1 from cron.job where jobname = 'xero-channel-summary-sync-monthly');

select cron.schedule(
  'xero-channel-summary-sync-monthly',
  '0 22 2 * *',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/xero-channel-summary-sync?sync=1',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
