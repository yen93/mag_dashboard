-- Schedule the ga4-click-to-call-sync edge function. Runs WEEKLY — 04:20 AM
-- Philippine Time on Monday (20:20 UTC Sunday; cron DOW 0 = Sunday UTC), just after
-- the ga4-website-traffic-sync weekly run (20:15 UTC).
--
-- Calls the GA4 Data API (runReport on property 363754280) to pull monthly
-- click_to_call (phone-click) events by channel per Australian FY, and UPSERTS one row
-- per (year_month, channel) into public.ga4_click_to_call_monthly via
-- public.reload_ga4_click_to_call_monthly(). Never truncates or deletes.
--
-- The function MUST be deployed with --no-verify-jwt (this POST has no auth header).

select cron.schedule(
  'ga4-click-to-call-sync-weekly',
  '20 20 * * 0',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/ga4-click-to-call-sync?sync=1',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
