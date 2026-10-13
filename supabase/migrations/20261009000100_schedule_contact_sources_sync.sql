-- Contact Sources — collapse the 3 staggered sync cron jobs into ONE scheduled
-- orchestrator (the contact-sources-sync edge function), which calls the three
-- existing functions in order. The edge functions themselves are kept; only their
-- individual pg_cron jobs are removed here.
--
-- Supersedes the schedules defined in:
--   supabase/schedule_ac_google_ads_deals_sync.txt   (ac-google-ads-deals-sync-daily)
--   supabase/migrations/20261007000100_schedule_ga4_ads_leads_sync.sql (ga4-ads-leads-sync-daily)
--   supabase/schedule_ga4_ac_custom_fields_sync.sql  (ga4-ac-custom-fields-sync-daily)
--
-- Requires extensions pg_cron + pg_net (already installed on this project).

-- ===== 1. remove the three individual jobs (idempotent) =====
do $$
begin
  perform cron.unschedule('ac-google-ads-deals-sync-daily');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('ga4-ads-leads-sync-daily');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('ga4-ac-custom-fields-sync-daily');
exception when others then null;
end $$;

-- (Left untouched on purpose: new-paid-leads-sync-daily, ac-ad-leads-sync-weekly,
--  and the externally-applied buyer-sheet-sync-daily / sales-deals-sync-daily.)

-- ===== 2. schedule the single orchestrator =====
-- '0 22 * * *' UTC = 06:00 Philippine time, DAILY. The POST returns 202 quickly;
-- the chain runs in the background inside the edge function, so a modest pg_net
-- timeout is enough here (it only needs to cover the 202 response).
do $$
begin
  perform cron.unschedule('contact-sources-sync-daily');
exception when others then null;
end $$;

select cron.schedule(
  'contact-sources-sync-daily',
  '0 22 * * *',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/contact-sources-sync',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
