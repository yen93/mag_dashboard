-- Weekly schedule for the google-ads-campaign-monthly-sync edge function.
-- Monday 06:00 Philippine Time = Sunday 22:00 UTC. The function is deployed
-- --no-verify-jwt, so the POST carries no Authorization header. It's quick
-- (~a few seconds), so the cron waits for it inline (no background mode).
-- Keeps public.google_ads_campaign_monthly fresh — the ad-spend denominator of
-- the dashboard ROAS tab (server/metrics/roas.js reads it live).

select cron.unschedule('google-ads-campaign-monthly-sync-weekly')
where exists (select 1 from cron.job where jobname = 'google-ads-campaign-monthly-sync-weekly');

select cron.schedule(
  'google-ads-campaign-monthly-sync-weekly',
  '0 22 * * 0',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/google-ads-campaign-monthly-sync',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
