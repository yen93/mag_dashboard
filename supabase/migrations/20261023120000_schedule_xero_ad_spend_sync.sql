-- Weekly schedule for xero-ad-spend-sync.
-- Monday 06:30 Philippine Time = Sunday 22:30 UTC — 30 min after the Google/Bing jobs so the
-- weekly refreshes don't all fire at once. The function is deployed --no-verify-jwt, so the POST
-- carries no Authorization header. It reads Xero BankTransactions for Microsoft Ads + Simple
-- Digital and rewrites public.bing_ads_campaign_monthly (campaign_id=0) and
-- public.simple_digital_fees_monthly — the Bing + Simple Digital halves of the ROAS All-in cost
-- basis (server/metrics/roas.js reads both live). Running weekly also keeps the Xero refresh token
-- (public.oauth_token_store, provider='xero') from lapsing (Xero refresh tokens expire after 60
-- days idle and rotate on every use). 150s pg_net timeout covers the paginated reads.
--
-- NOTE: this is now the SOLE Bing source. Do NOT also apply the bing-ads-campaign-monthly-sync
-- cron (it writes per-campaign rows with campaign_id<>0; roas.js sums all rows, so running both
-- would double-count Bing). The Microsoft Advertising API sync is superseded by this Xero sync.

select cron.unschedule('xero-ad-spend-sync-weekly')
where exists (select 1 from cron.job where jobname = 'xero-ad-spend-sync-weekly');

select cron.schedule(
  'xero-ad-spend-sync-weekly',
  '30 22 * * 0',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/xero-ad-spend-sync?sync=1',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
