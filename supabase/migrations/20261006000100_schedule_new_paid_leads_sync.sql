-- Schedule the new-paid-leads-sync edge function Mon-Fri 06:00 Philippine time.
-- 06:00 PH (UTC+8) = 22:00 UTC the previous day, so Mon-Fri 06:00 PH = Sun-Thu
-- 22:00 UTC = cron '0 22 * * 0-4' (same cadence as buyer-sheet-sync-daily /
-- sales-deals-sync-daily). The function is deployed verify_jwt:false, so the
-- pg_net call needs no Authorization header. Applied via Supabase MCP.
-- Requires extensions pg_cron + pg_net (already installed on this project).

select cron.schedule(
  'new-paid-leads-sync-daily',
  '0 22 * * 0-4',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/new-paid-leads-sync',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
  $$
);
