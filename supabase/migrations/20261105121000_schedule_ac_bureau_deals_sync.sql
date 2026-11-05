-- Schedule the ac-bureau-deals-sync edge function. Runs 06:15 AM Philippine Time,
-- Mon–Fri (22:15 UTC, cron DOW 0-4 = Sun–Thu UTC) — AFTER the deal mirror
-- (activecampaign-deals-sync, 05:00 PH) and the contacts mirror
-- (activecampaign-contacts-sync, 05:30 PH) have refreshed, so the rebuild joins
-- against fresh deal/contact/account rows.
--
-- Called with ?sync=1 and a 120s pg_net timeout so the ~15s pull+rebuild runs to
-- completion inline. The edge function emails ALERT_EMAIL on any failure and the
-- rebuild is transactional, so a failed run leaves the previous rows intact.

select cron.schedule(
  'ac-bureau-deals-sync-daily',
  '15 22 * * 0-4',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/ac-bureau-deals-sync?sync=1',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
