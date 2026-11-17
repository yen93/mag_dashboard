-- Add a dedicated 'check_in' ticket type for the Fortnightly Team Check-in form.
--
-- The check-in form (public/checkin.html → POST /api/checkin) files its responses
-- as tickets on the existing board (public.dashboard_tickets) so they're triaged in
-- one place. They get their own type (not folded into 'feedback') so admins can
-- filter the recurring pulse-check apart from ad-hoc feedback.
--
-- This only widens the ticket_type CHECK constraint — no data change. The table is
-- still written live by the dashboard server; nothing truncates or deletes here.

alter table public.dashboard_tickets
  drop constraint if exists dashboard_tickets_ticket_type_check;

alter table public.dashboard_tickets
  add constraint dashboard_tickets_ticket_type_check
  check (ticket_type in ('issue', 'feedback', 'build_feedback', 'build_request', 'check_in', 'other'));
