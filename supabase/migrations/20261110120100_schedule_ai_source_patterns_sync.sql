-- Schedule the ai-source-patterns-sync edge function. Runs MONTHLY — on the 1st
-- at 22:00 UTC (06:00 AM Philippine Time on the 2nd).
--
-- Re-asserts the curated AI-source baseline and asks OpenAI for any newly-launched
-- AI-assistant referral domains, APPENDING only ones not already present into
-- public.ai_source_patterns via public.reload_ai_source_patterns(). Insert-only —
-- never updates or deletes existing patterns.
--
-- The function MUST be deployed with --no-verify-jwt (this POST has no auth header).

select cron.schedule(
  'ai-source-patterns-sync-monthly',
  '0 22 1 * *',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/ai-source-patterns-sync?sync=1',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
