-- Schedule the fortnightly-checkin-email edge function.
--
-- pg_cron can't express "every 2 weeks", so this fires WEEKLY every Friday at
-- 06:00 UTC = 14:00 (2:00 PM) Manila, and the edge function itself gates on a
-- fortnight anchor (CHECKIN_ANCHOR, default 2026-11-20) so it only actually emails
-- the team on every OTHER Friday. Off-weeks return a quiet "not-due" no-op.
--
-- The function reads public.organization_users (service role) and emails each a link
-- to the Team Check-in form. It writes nothing.
--
-- Deploy command (MUST be --no-verify-jwt so the pg_cron/net.http_post call runs):
--   supabase functions deploy fortnightly-checkin-email --no-verify-jwt

select cron.schedule(
  'fortnightly-checkin-email-weekly',
  '0 6 * * 5',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/fortnightly-checkin-email',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
