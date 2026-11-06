-- Schedule the apify-platforms-sync edge function. Runs WEEKLY — 04:00 AM Philippine
-- Time on Monday (20:00 UTC Sunday; cron DOW 0 = Sunday UTC). Social scrapes only
-- capture the CURRENT public state, so one weekly snapshot per platform is enough;
-- the dashboard derives week-over-week "Change" from consecutive snapshots.
--
-- Called with ?sync=1 and a 120s pg_net timeout so the Apify scrape + upsert runs to
-- completion inline. The edge function emails ALERT_EMAIL on total failure, upserts
-- only (never truncates), and refuses an empty payload, so a failed/partial run
-- leaves the previous snapshots intact (a platform missing this week keeps its last
-- snapshot). The function MUST be deployed --no-verify-jwt (this POST has no auth header).
--
-- DO NOT APPLY until the edge function is deployed and a ?dry=1 run has confirmed the
-- per-platform actor outputs parse correctly.

select cron.schedule(
  'apify-platforms-sync-weekly',
  '0 20 * * 0',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/apify-platforms-sync?sync=1',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
