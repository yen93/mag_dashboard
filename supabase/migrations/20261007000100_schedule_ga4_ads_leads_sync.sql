-- SUPERSEDED (2026-10-09): the 'ga4-ads-leads-sync-daily' job created here is now
-- removed and replaced by the single 'contact-sources-sync-daily' orchestrator in
-- 20261009000100_schedule_contact_sources_sync.sql. On a fresh apply this job is
-- created then unscheduled by that later migration (end state: gone). The
-- ga4-ads-leads-sync edge function itself is kept and is called by the orchestrator.
--
-- Schedule the ga4-ads-leads-sync edge function Mon-Fri 06:00 Philippine time.
-- 06:00 PH (UTC+8) = 22:00 UTC the previous day, so Mon-Fri 06:00 PH = Sun-Thu
-- 22:00 UTC = cron '0 22 * * 0-4' (same cadence as the other *-sync jobs).
-- The function is deployed verify_jwt:false and returns 202 immediately (the work
-- runs in the background), so the pg_net call just needs to fire it.
-- Requires extensions pg_cron + pg_net (already installed on this project).

select cron.schedule(
  'ga4-ads-leads-sync-daily',
  '0 22 * * 0-4',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/ga4-ads-leads-sync',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
  $$
);
