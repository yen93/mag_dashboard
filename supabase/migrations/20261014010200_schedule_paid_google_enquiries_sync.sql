-- Schedule the paid-google-enquiries-sync edge function (refreshes the AC-live
-- columns of the anchored 39 "Paid - Google" enquiries from the AC mirror; upsert
-- only, never truncates). '30 22 * * *' UTC = 06:30 Philippine time, DAILY — a bit
-- after the AC-mirror sync jobs (sales-deals-sync / update-deals 06:00-07:00 PH)
-- so it reads settled deal values. The POST returns 202 quickly; the work runs in
-- the background inside the edge function, so a modest pg_net timeout is enough.
--
-- Requires extensions pg_cron + pg_net (already installed on this project).
-- The function is deployed verify_jwt=false, so the POST sends no Authorization
-- header (Content-Type only).

do $$
begin
  perform cron.unschedule('paid-google-enquiries-sync-daily');
exception when others then null;
end $$;

select cron.schedule(
  'paid-google-enquiries-sync-daily',
  '30 22 * * *',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/paid-google-enquiries-sync',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
