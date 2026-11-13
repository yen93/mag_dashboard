-- Schedule the ac-google-ads-yes-deals-sync edge function. Runs WEEKLY — Monday
-- 06:20 AM Philippine Time (Sunday 22:20 UTC, cron '20 22 * * 0') — after the daily
-- deal/contact mirrors have long settled, so the rebuild joins against fresh
-- deal/contact/account rows.
--
-- Called with ?sync=1 and a 120s pg_net timeout so the pull+rebuild runs to
-- completion inline. The edge function emails ALERT_EMAIL on any failure and the
-- rebuild is UPSERT-ONLY + refuses an empty payload, so a failed run leaves the
-- previous rows intact.

select cron.schedule(
  'ac-google-ads-yes-deals-sync-weekly',
  '20 22 * * 0',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/ac-google-ads-yes-deals-sync?sync=1',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
