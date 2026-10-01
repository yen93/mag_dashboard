# CLAUDE.md — MAG Buyer Sheet feature

Dev notes for the **Buyer Sheet** page on the MAG Metrics dashboard and its daily
pipeline. The feature's code lives in the dashboard repo one level up
(`C:/Users/Cloverly/claude_code/dashboard`); this folder holds the user guide,
diagrams, chat history, and `as_built.txt`. Read the repo-root `CLAUDE.md` for the
dashboard's overall conventions first.

## The non-obvious bit: the page reads a cache, not AC
The dashboard does **not** call ActiveCampaign or OpenAI at request time. A daily
Supabase Edge Function pre-builds everything into one table, and the page just
SELECTs it:

```
AC + Supabase mirror + OpenAI web search
        └─> edge fn `buyer-sheet-sync`  (pg_cron, Mon–Fri 6am PH)
              └─> table public.mag_buyer_sheet
                    └─> /api/operations/buyer-sheet  ->  public/mag_buyer_sheet.html
```

- Supabase project: **MAGTestProject `aivitcomiywiysrfwqxt`** (holds the AC mirror
  `activecampaign_deals/_contacts/_accounts` and the cache table).
- Scope = all pipelines where `activecampaign_deals.status = 1` (won), one row per deal.

## Key files
- `supabase/functions/buyer-sheet-sync/index.ts` — the edge function (Deno/TS).
- `server/metrics/mag-buyer-sheet.js` — reads the table, maps to the page payload, computes the chip status.
- `server/index.js` — `GET /api/operations/buyer-sheet` (requireAuth, 10-min cache).
- `public/mag_buyer_sheet.html` — the table page (reuses `renderSortableTable`); full-width via a page-scoped `.content { max-width:none }`.

## Deploy / test
- **Edge function:** deploy via the Supabase MCP `deploy_edge_function` with
  `verify_jwt:false`. There is no CLI inlining helper — a redeploy must pass the
  full file content. Test a run with
  `curl ".../functions/v1/buyer-sheet-sync?sync=1&limit=N"` (returns a JSON
  summary incl. `model`/`search_context`); bare GET runs async. Secrets
  (`OPENAI_API_KEY`, `AC_API_URL`, `AC_API_TOKEN`, `OPENAI_MODEL`,
  `OPENAI_SEARCH_CONTEXT`) are Supabase function secrets — never in the repo.
- **Dashboard:** `gcloud run deploy dashboard --source . --region australia-southeast1`
  with **NO `--set-secrets`/`--set-env-vars`** — a bare source deploy preserves all
  existing secrets. The repo-root CLAUDE.md's `--set-secrets SUPABASE_DB_URL=...`
  would REPLACE the whole secret set and drop `AC_API_URL`/`AC_API_KEY`, breaking
  the Sales page. gcloud lives at
  `C:/Users/Cloverly/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd`.
- **Schedule:** pg_cron `buyer-sheet-sync-daily`, `0 22 * * 0-4` UTC = 6am PH
  Mon–Fri (22:00 UTC Sun–Thu rolls into Mon–Fri PH). Edit via `cron.schedule`.

## Gotchas
- **`activecampaign_deals.event_date` is NULL for every row** in the mirror. Real
  event date comes from AC deal custom field #7; the deal-title text is only a
  fallback, and only when a segment contains an explicit `20xx` year (loose
  parsing produced garbage years like 2029/2031).
- **`event_date`, `year`, `direct_indirect` are enrichment-owned**, deliberately
  left OUT of the base upsert so the daily base refresh doesn't clobber the
  AC-authoritative values. Only `enrichFromAC` writes them (AC field first, title
  fallback).
- **Dedupe deal ids** before upserting — the mirror occasionally holds duplicate
  deal rows, which otherwise trips "ON CONFLICT ... cannot affect row a second time".
- **Enrichment is incremental & cost-aware.** Candidates = rows not enriched and
  under `MAX_ENRICH_ATTEMPTS` (2); already-enriched unchanged rows are skipped.
  Rows that fail web search twice are **parked** (left blank, never guessed).
  Model is `gpt-4o-mini` + `search_context: low` to keep cost down.
- **Chip status logic** (`mag-buyer-sheet.js`): `partial` only while rows are
  *actively pending*; once nothing is pending it reads `live` even though some
  rows are parked/blank. `enrichment_attempts` is read for this but stripped from
  the payload.
- **`deal_status`/`lost_at`** are reconciled each run (a deal that leaves "won" is
  tagged lost/open/removed and time-stamped, never deleted) but are **not served
  to the page** — backend tracking only.

## Secrets
Never commit secret values. Supabase `SUPABASE_DB_URL` and the AC creds live in
Google Secret Manager → Cloud Run; OpenAI + AC creds for the edge function live
as Supabase function secrets.
