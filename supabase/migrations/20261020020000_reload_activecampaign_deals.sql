-- reload_activecampaign_deals(_deals jsonb)
-- Atomically refreshes public.activecampaign_deals from a full snapshot of AC deals.
-- Replaces the old n8n "Get All AC Deals" workflow (webhook 02b6362d-…), which
-- deleted the table FIRST and then re-fetched/inserted — so any failure after the
-- DELETE left the table empty (the recurring "deal column blank" bug).
--
-- This function does the destructive part only AFTER a valid, non-empty snapshot is
-- in hand, and the whole null-refs → delete → insert runs in ONE transaction, so a
-- failure rolls back and the previous rows are preserved.
--
-- Called by the activecampaign-deals-sync edge function.

create or replace function public.reload_activecampaign_deals(_deals jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n int;
begin
  -- Safety guard: never wipe the table on an empty / missing payload.
  if _deals is null or jsonb_typeof(_deals) <> 'array' or jsonb_array_length(_deals) = 0 then
    raise exception 'reload_activecampaign_deals: refusing to reload with empty payload';
  end if;

  -- 1. Clear the FK references in google_reviews (FK -> activecampaign_deals.internal_id,
  --    ON DELETE NO ACTION) so the delete below is allowed. internal_id is regenerated
  --    on reload, so these links are invalidated by the reload regardless.
  update public.google_reviews
     set closest_event_id = null
   where closest_event_id in (select internal_id from public.activecampaign_deals);

  -- 2. Replace all rows. (WHERE internal_id IS NOT NULL matches every row — internal_id
  --    is NOT NULL — and satisfies sql_safe_updates, which is ON for this project.)
  delete from public.activecampaign_deals where internal_id is not null;

  insert into public.activecampaign_deals
    (id, hash, owner, contact, organization, "group", stage, title, description,
     percent, cdate, mdate, nextdate, nexttaskid, value, currency,
     "winProbability", "winProbabilityMdate", status, activitycount, nextdealid,
     edate, links, "isDisabled", account, "customerAccount")
  select
    d->>'id',
    d->>'hash',
    d->>'owner',
    d->>'contact',
    d->>'organization',
    d->>'group',
    d->>'stage',
    d->>'title',
    d->>'description',
    nullif(d->>'percent','')::numeric,
    nullif(d->>'cdate','')::timestamptz,
    nullif(d->>'mdate','')::timestamptz,
    nullif(d->>'nextdate','')::timestamptz,
    d->>'nexttaskid',
    nullif(d->>'value','')::numeric,
    d->>'currency',
    nullif(d->>'winProbability','')::numeric,
    nullif(d->>'winProbabilityMdate','')::timestamptz,
    nullif(d->>'status','')::int,
    nullif(d->>'activitycount','')::int,
    d->>'nextdealid',
    nullif(d->>'edate','')::timestamptz,
    case when jsonb_typeof(d->'links') in ('object','array') then d->'links' else null end,
    coalesce(nullif(d->>'isDisabled','')::boolean, false),
    d->>'account',
    d->>'customerAccount'
  from jsonb_array_elements(_deals) as d;

  get diagnostics n = row_count;
  return n;
end;
$$;
