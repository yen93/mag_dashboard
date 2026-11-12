-- Schedule the monitoring-health-digest edge function.
-- Runs DAILY Mon–Fri at 06:30 AM Philippine Time (22:30 UTC; cron DOW 0-4 = Sun-Thu UTC).
--
-- Audits all 3 dashboard monitoring tabs:
-- 1. DB Automations (Edge Functions & pg_cron in MAG Supabase)
-- 2. Claude Code Routines (Weekly and on-demand cloud agents)
-- 3. n8n Automations (Webhooks & workflows on n8n Cloud Run)
--
-- Compiles execution telemetry, highlights any errors and warnings, and dispatches an HTML
-- email digest to the administrator via Gmail SMTP.
--
-- Deploy command (MUST be --no-verify-jwt so the pg_cron/net.http_post call with no auth header runs):
--   supabase functions deploy monitoring-health-digest --no-verify-jwt

select cron.schedule(
  'monitoring-health-digest-daily',
  '30 22 * * 0-4',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/monitoring-health-digest',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
