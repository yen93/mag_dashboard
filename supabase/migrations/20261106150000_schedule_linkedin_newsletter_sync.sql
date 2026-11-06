-- Schedule linkedin-newsletter-sync WEEKLY — Mon 04:30 PH (Sun 20:30 UTC), 30 min after
-- the apify-platforms-sync. Fetches the LinkedIn newsletter page with the LINKEDIN_LI_AT
-- cookie, parses subscriberCount, upserts public.content_social_metrics. Calls ?sync=1
-- inline (120s pg_net timeout). On a failed/challenged fetch it writes nothing and emails
-- ALERT_EMAIL (cookie likely expired). Function deployed --no-verify-jwt (no auth header).

select cron.schedule(
  'linkedin-newsletter-sync-weekly',
  '30 20 * * 0',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/linkedin-newsletter-sync?sync=1',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
