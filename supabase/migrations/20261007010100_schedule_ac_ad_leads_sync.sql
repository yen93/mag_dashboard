-- Schedule the ac-ad-leads-sync edge function weekly every Monday 06:30 Philippine time.
-- 06:30 PH (UTC+8) Monday = Sunday 22:30 UTC = cron '30 22 * * 0'.
-- The function is deployed verify_jwt:false, so the pg_net call needs no Authorization header.
-- Appending ?sync=1 ensures the function executes synchronously to completion.

select cron.schedule(
  'ac-ad-leads-sync-weekly',
  '30 22 * * 0',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/ac-ad-leads-sync?sync=1',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
  $$
);
