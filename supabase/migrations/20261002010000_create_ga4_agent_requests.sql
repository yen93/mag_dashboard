-- MAG GA4 Agent — on-demand request/response hand-off table.
--
-- The dashboard inserts a 'pending' row (one per user question) and fires the
-- "GA4 On-Demand Report" Claude routine; the routine claims the oldest pending
-- row, runs the GA4 pull in its cloud environment, and writes the markdown
-- result back, flipping status to 'done' (or 'error'). The dashboard polls the
-- row by id. Mirrors the sales-topline / invoice-tracking "routine writes a
-- Supabase table, dashboard reads it" pattern.

create table if not exists public.ga4_agent_requests (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  status text not null default 'pending',   -- pending | processing | done | error
  result text,                              -- markdown table written by the routine
  error text,
  requested_by text,                        -- dashboard user email (from JWT)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ga4_agent_requests_status_created_idx
  on public.ga4_agent_requests (status, created_at);
