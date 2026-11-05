-- Add is_tailor to public.ac_indirect_deals.
-- ---------------------------------------------------------------------------
-- A deal is a "Tailor" deal when its title mentions "The Tailor" (MAG's Tailor
-- offering). Flagged purely from the title: is_tailor = (title ILIKE '%the tailor%').
-- The reload rpc (see 20261105150000) computes this on every upsert; this migration
-- adds the column and backfills the existing rows with the same rule.

alter table public.ac_indirect_deals
  add column if not exists is_tailor boolean not null default false;

-- Backfill existing rows from the title rule.
update public.ac_indirect_deals
  set is_tailor = (title ilike '%the tailor%')
  where is_tailor is distinct from (title ilike '%the tailor%');

create index if not exists ac_indirect_deals_is_tailor_idx
  on public.ac_indirect_deals (is_tailor);
