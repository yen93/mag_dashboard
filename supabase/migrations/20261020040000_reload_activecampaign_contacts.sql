-- reload_activecampaign_contacts(_contacts jsonb)
-- Atomically refreshes public.activecampaign_contacts from a full snapshot of AC contacts.
-- Replaces the old n8n "Get All AC Contacts" workflow (webhook
-- 8388b39d-9c99-494e-9991-2fefb0081a87), which — like the deals workflow — deleted the
-- table FIRST and then re-fetched/inserted, so any failure after the DELETE left the
-- table empty.
--
-- This function does the destructive part only AFTER a valid, non-empty snapshot is in
-- hand, and the delete + insert runs in ONE transaction, so a failure rolls back and the
-- previous rows are preserved. No table has a foreign key onto activecampaign_contacts
-- (PK = id, text), so — unlike reload_activecampaign_deals — there are no FK refs to null
-- first.
--
-- Called by the activecampaign-contacts-sync edge function. The column set mirrors the AC
-- v3 /api/3/contacts list object verbatim (text fields stored as-is incl. empty strings,
-- to match what the n8n node wrote); created_at is omitted so its DEFAULT now() stamps the
-- load time, exactly as before.

create or replace function public.reload_activecampaign_contacts(_contacts jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
-- The PostgREST API role (authenticator) has statement_timeout = 8s, far too short for a
-- ~15k-row reload. This function-scoped override lifts it to 120s for this rpc only.
set statement_timeout to '120000'
as $$
declare
  n int;
begin
  -- Safety guard: never wipe the table on an empty / missing payload.
  if _contacts is null or jsonb_typeof(_contacts) <> 'array' or jsonb_array_length(_contacts) = 0 then
    raise exception 'reload_activecampaign_contacts: refusing to reload with empty payload';
  end if;

  -- Replace all rows. (WHERE id IS NOT NULL matches every row — id is the NOT NULL PK —
  -- and satisfies sql_safe_updates, which is ON for this project.)
  delete from public.activecampaign_contacts where id is not null;

  insert into public.activecampaign_contacts
    (id, email, phone, "firstName", "lastName", orgid, orgname, organization,
     segmentio_id, bounced_hard, bounced_soft, bounced_date, ip, ua, hash,
     socialdata_lastcheck, email_local, email_domain, sentcnt, rating_tstamp, gravatar,
     deleted, anonymized, adate, udate, edate, cdate, deleted_at, created_utc_timestamp,
     updated_utc_timestamp, created_timestamp, updated_timestamp, created_by, updated_by,
     mpp_tracking, last_click_date, last_open_date, last_mpp_open_date, best_send_hour,
     sms_consent, sms_consent_updated_at, whatsapp_id, whatsapp_username,
     "scoreValues", "accountContacts", links)
  select
    d->>'id',
    d->>'email',
    d->>'phone',
    d->>'firstName',
    d->>'lastName',
    d->>'orgid',
    d->>'orgname',
    d->>'organization',
    d->>'segmentio_id',
    d->>'bounced_hard',
    d->>'bounced_soft',
    nullif(d->>'bounced_date','')::timestamptz,
    d->>'ip',
    d->>'ua',
    d->>'hash',
    nullif(d->>'socialdata_lastcheck','')::timestamptz,
    d->>'email_local',
    d->>'email_domain',
    nullif(d->>'sentcnt','')::int,
    nullif(d->>'rating_tstamp','')::date,
    d->>'gravatar',
    d->>'deleted',
    d->>'anonymized',
    nullif(d->>'adate','')::timestamptz,
    nullif(d->>'udate','')::timestamptz,
    nullif(d->>'edate','')::timestamptz,
    nullif(d->>'cdate','')::timestamptz,
    nullif(d->>'deleted_at','')::timestamptz,
    nullif(d->>'created_utc_timestamp','')::timestamptz,
    nullif(d->>'updated_utc_timestamp','')::timestamptz,
    nullif(d->>'created_timestamp','')::timestamptz,
    nullif(d->>'updated_timestamp','')::timestamptz,
    d->>'created_by',
    d->>'updated_by',
    d->>'mpp_tracking',
    nullif(d->>'last_click_date','')::timestamptz,
    nullif(d->>'last_open_date','')::timestamptz,
    nullif(d->>'last_mpp_open_date','')::timestamptz,
    d->>'best_send_hour',
    d->>'sms_consent',
    d->>'sms_consent_updated_at',
    d->>'whatsapp_id',
    d->>'whatsapp_username',
    case when jsonb_typeof(d->'scoreValues')    in ('array','object') then d->'scoreValues'    else '[]'::jsonb end,
    case when jsonb_typeof(d->'accountContacts') in ('array','object') then d->'accountContacts' else '[]'::jsonb end,
    case when jsonb_typeof(d->'links')          in ('object','array') then d->'links'          else '{}'::jsonb end
  from jsonb_array_elements(_contacts) as d;

  get diagnostics n = row_count;
  return n;
end;
$$;
