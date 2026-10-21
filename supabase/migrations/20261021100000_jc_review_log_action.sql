-- Add an `action` column to the JC manual-review audit log so a "reset" (the
-- override row removed → the contact goes back to "for review") is distinguishable
-- from a "set" (tagged "Could be SEO or Paid Ad", or reviewed as "Not paid ad / SEO",
-- both of which carry a decision value / NULL). Existing rows default to 'set'.
alter table public.ga4cs_jc_manual_review_log
  add column if not exists action text not null default 'set';
