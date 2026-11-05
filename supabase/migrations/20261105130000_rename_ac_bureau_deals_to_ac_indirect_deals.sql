-- Rename the ac_bureau_deals cache + its machinery to "indirect" (matches the
-- Deal Source? option value "Indirect (PCO/ Bureau/ Events company)"). The table,
-- its indexes/pkey and the reload rpc are renamed, and the daily cron is re-pointed
-- at the renamed edge function (ac-bureau-deals-sync → ac-indirect-deals-sync).
--
-- NB: ALTER FUNCTION ... RENAME only changes the name, not the body — the function's
-- body still references the old table name, so 20261105131000_reload_ac_indirect_deals_body
-- re-creates it against public.ac_indirect_deals.

alter table public.ac_bureau_deals rename to ac_indirect_deals;
alter index ac_bureau_deals_cdate_idx  rename to ac_indirect_deals_cdate_idx;
alter index ac_bureau_deals_status_idx rename to ac_indirect_deals_status_idx;
alter index ac_bureau_deals_fy_idx     rename to ac_indirect_deals_fy_idx;
alter index ac_bureau_deals_pkey       rename to ac_indirect_deals_pkey;

alter function public.reload_ac_bureau_deals(jsonb) rename to reload_ac_indirect_deals;

select cron.unschedule('ac-bureau-deals-sync-daily');
select cron.schedule(
  'ac-indirect-deals-sync-daily',
  '15 22 * * 0-4',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/ac-indirect-deals-sync?sync=1',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
