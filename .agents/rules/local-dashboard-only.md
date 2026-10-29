---
trigger: always_on
description: Strictly restrict file edits to C:\Users\Cloverly\claude_code\dashboard only; enforce read-only access everywhere else (DB, Cloud Run, external services) and do not touch git or deploy.
---

# Workspace Access & Safety Rules (STRICT)

## 1. Local File Editing Scope (`C:\Users\Cloverly\claude_code\dashboard` ONLY)
- **Allowed writes:** You may ONLY create, edit, or delete local files inside `C:\Users\Cloverly\claude_code\dashboard` (and its subdirectories).
- **Outside this folder = READ-ONLY:** You have **read-only** access everywhere else on the filesystem. Never create, modify, move, or delete any file outside `C:\Users\Cloverly\claude_code\dashboard`.

## 2. Database, Cloud, and External Services — READ-ONLY ONLY
- **Supabase / Postgres Database (READ-ONLY):**
  - Only execute read-only queries (`SELECT`, `EXPLAIN`, `SHOW`).
  - **NEVER** execute `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, or mutating functions/RPCs against the database, and **NEVER** run `supabase db push` or apply migrations directly.
  - When a schema change or seed is needed, write the SQL to a local file in `supabase/migrations/` so the user can review and run it manually.
- **Google Cloud / Cloud Run / Secret Manager (READ-ONLY):**
  - **NEVER** deploy or update services (`gcloud run deploy`, `gcloud run services update`, etc.) or modify secrets.
  - Only read-only inspection commands (e.g., `gcloud run services describe`, `gcloud run services list`, `gcloud logging read`) are allowed.
- **Supabase Edge Functions & CLI (READ-ONLY):**
  - **NEVER** deploy edge functions (`supabase functions deploy`) or set/unset Supabase secrets.
- **External APIs & MCP Tools (READ-ONLY):**
  - Only perform read/fetch/list operations against Xero, ActiveCampaign, Google Ads, Microsoft/Bing Ads, GA4, Calendly, Gmail, or any other external service. Never trigger write/sync/mutation calls.

## 3. Git & Version Control — DO NOT TOUCH
- **NEVER** stage, commit, push, pull, checkout, reset, stash, merge, rebase, or otherwise modify git state (`git add`, `git commit`, `git push`, etc. are strictly forbidden).
