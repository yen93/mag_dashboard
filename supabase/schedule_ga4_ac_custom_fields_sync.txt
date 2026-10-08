-- Schedule the ga4-ac-custom-fields-sync edge function daily at 07:10 AM Philippine time.
-- 07:10 AM PH (UTC+8) = 23:10 UTC previous day -> cron '10 23 * * *'
--
-- Flow:
-- 1. 06:00 AM PHT (22:00 UTC): ga4-ads-leads-sync rebuilds ga4_ac_contact_source
-- 2. 07:00 AM PHT (23:00 UTC): update_ga4_contact_deals links deal_id
-- 3. 07:10 AM PHT (23:10 UTC): ga4-ac-custom-fields-sync populates Google Ads? & Deal Source? fields

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Unschedule first if it already exists (prevents duplicate job errors)
DO $$
BEGIN
  PERFORM cron.unschedule('ga4-ac-custom-fields-sync-daily');
EXCEPTION WHEN OTHERS THEN
  -- ignore if job did not exist yet
END $$;

SELECT cron.schedule(
  'ga4-ac-custom-fields-sync-daily',
  '10 23 * * *',
  $$
  SELECT net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/ga4-ac-custom-fields-sync?sync=1',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
