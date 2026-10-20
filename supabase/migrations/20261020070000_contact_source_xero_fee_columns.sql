-- GA4 Leads Tracker: add the Xero fee-breakdown columns to the ga4_ac_contact_source
-- cache table (surfaced behind a "Show Xero $" toggle on ac_contact_sources.html).
--
-- engagement_fee / other_fees / gst / amount_total are the Xero-invoiced breakdown of a
-- deal, and live on public.mag_gads_direct_inbound_lead_source keyed by deal_id — the SAME
-- table and join key that jc_manual_tag already mirrors (see
-- 20261020060000_contact_source_fy_calyr_jc_columns.sql). deal_id is unique there (one row
-- per deal), and mag_gads.deal_value is identical to the deal_value this page already shows
-- as "AC Value", so only the fee breakdown is added here (no duplicate deal_value column).
--
-- Implementation mirrors jc_manual_tag exactly: the existing BEFORE INSERT/UPDATE OF deal_id
-- trigger (trg_ga4cs_jc_manual_tag -> ga4cs_set_jc_manual_tag()) is extended to also populate
-- these four from the SAME mag_gads lookup, so NEITHER rebuild_ga4_ac_matches() NOR
-- update_ga4_contact_deals() needs editing — the figures follow deal_id no matter which job
-- (re)links it, and the static roas-<deal_id> audit rows keep their one-time backfill values.

-- ---- columns -------------------------------------------------------------------
alter table public.ga4_ac_contact_source
  add column if not exists engagement_fee numeric,
  add column if not exists other_fees     numeric,
  add column if not exists gst            numeric,
  add column if not exists amount_total   numeric;

-- ---- extend the deal_id trigger to also carry the Xero fee breakdown -----------
-- Folded into the one lookup the trigger already runs; deal_id is unique in mag_gads so the
-- "order by jc_final_attr nulls last limit 1" result (and thus jc_manual_tag) is unchanged.
create or replace function public.ga4cs_set_jc_manual_tag()
  returns trigger language plpgsql
  set search_path to 'public' as
$$
begin
  if NEW.deal_id is null then
    NEW.jc_manual_tag  := null;
    NEW.engagement_fee := null;
    NEW.other_fees     := null;
    NEW.gst            := null;
    NEW.amount_total   := null;
  else
    select g.jc_final_attr, g.engagement_fee, g.other_fees, g.gst, g.amount_total
      into NEW.jc_manual_tag, NEW.engagement_fee, NEW.other_fees, NEW.gst, NEW.amount_total
    from public.mag_gads_direct_inbound_lead_source g
    where g.deal_id::text = NEW.deal_id::text
    order by g.jc_final_attr nulls last
    limit 1;
  end if;
  return NEW;
end;
$$;

-- Trigger definition is unchanged (still BEFORE INSERT OR UPDATE OF deal_id), re-created so a
-- fresh apply on a clean DB wires it up regardless of migration order.
drop trigger if exists trg_ga4cs_jc_manual_tag on public.ga4_ac_contact_source;
create trigger trg_ga4cs_jc_manual_tag
  before insert or update of deal_id on public.ga4_ac_contact_source
  for each row execute function public.ga4cs_set_jc_manual_tag();

-- ---- one-time backfill for existing rows (incl. the static roas-* audit rows) ---
update public.ga4_ac_contact_source cs
set engagement_fee = g.engagement_fee,
    other_fees     = g.other_fees,
    gst            = g.gst,
    amount_total   = g.amount_total
from (
  select distinct on (deal_id) deal_id, engagement_fee, other_fees, gst, amount_total
  from public.mag_gads_direct_inbound_lead_source
  where deal_id is not null
  order by deal_id, jc_final_attr nulls last
) g
where cs.deal_id is not null
  and g.deal_id::text = cs.deal_id::text
  and (cs.engagement_fee is distinct from g.engagement_fee
    or cs.other_fees     is distinct from g.other_fees
    or cs.gst            is distinct from g.gst
    or cs.amount_total   is distinct from g.amount_total);
