-- Schedule the activecampaign-contacts-sync edge function (replaces the old n8n
-- "Get All AC Contacts" workflow, webhook 8388b39d-…, which lived in the separate
-- n8n-production project as cron jobid 8 "n8n-get-all-ac-contacts", 05 22 * * 0-4 =
-- 06:05 AM PH — i.e. AFTER the consumer batch). Runs 05:30 AM Philippine Time, Mon–Fri
-- (21:30 UTC, cron DOW 0-4 = Sun–Thu UTC): 30 min AFTER activecampaign-deals-sync
-- (21:00 UTC, so the two full AC snapshots don't hammer the API at once) and still a
-- clear 30 min BEFORE the 22:00 UTC / 06:00 PH consumer batch (contact-sources-sync,
-- buyer-sheet-sync, sales-deals-sync, …) that reads activecampaign_contacts to roll up
-- the GA4 / Contact Sources page.
--
-- Called with ?sync=1 and a 150s pg_net timeout (matching the edge gateway wall clock) so
-- the full reload (~156 pages of 100, ~95s observed) runs to completion inline — the
-- function's async/background mode does NOT reliably finish a job this long. The function's
-- own internal budget (WALL_CLOCK_MS=140s) trips first on a slow run, so a failure returns a
-- clean 500 and emails ALERT_EMAIL rather than being killed with a silent 504.

select cron.schedule(
  'activecampaign-contacts-sync-daily',
  '30 21 * * 0-4',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/activecampaign-contacts-sync?sync=1',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
