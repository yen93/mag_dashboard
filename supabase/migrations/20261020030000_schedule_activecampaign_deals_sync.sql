-- Schedule the activecampaign-deals-sync edge function (replaces the old n8n
-- "Get All AC Deals" workflow). Runs 05:00 AM Philippine Time, Mon–Fri
-- (21:00 UTC, cron DOW 0-4 = Sun–Thu UTC) — a full hour BEFORE every other
-- scheduled job (the 22:00 UTC consumer batch: contact-sources-sync,
-- buyer-sheet-sync, sales-deals-sync, …) so activecampaign_deals is fully
-- refreshed before anything reads it to denormalize deal_title/value/status.
--
-- Called with ?sync=1 and a 120s pg_net timeout so the ~40s full reload runs to
-- completion inline (the function's async/background mode does NOT reliably finish
-- a job this long). The edge function emails ALERT_EMAIL on any failure.

select cron.schedule(
  'activecampaign-deals-sync-daily',
  '0 21 * * 0-4',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/activecampaign-deals-sync?sync=1',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
