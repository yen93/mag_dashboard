-- Schedule the ga4-website-traffic-sync edge function. Runs WEEKLY — 04:15 AM
-- Philippine Time on Monday (20:15 UTC Sunday; cron DOW 0 = Sunday UTC).
--
-- Calls the GA4 Data API (runReport on property 363754280) to pull Website Sessions
-- and Visits from AI tools per Australian FY, and UPSERTS one row per
-- (fy_end, snapshot_date) into public.ga4_website_traffic_snapshots via
-- public.reload_ga4_website_traffic_snapshots(). Never truncates or deletes.
--
-- The function MUST be deployed with --no-verify-jwt (this POST has no auth header).

select cron.schedule(
  'ga4-website-traffic-sync-weekly',
  '15 20 * * 0',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/ga4-website-traffic-sync?sync=1',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
