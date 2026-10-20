# roas-year-on-year-sync — weekly ROAS (Year-on-Year) refresh

Populates `public.roas_year_on_year`, the cache behind the dashboard **ROAS** tab
(`/api/operations/roas` → `server/metrics/roas.js`). Same model as the
Invoices / Sales-Top-Line syncs: a scheduled job fills a Supabase cache table;
the dashboard only ever `SELECT`s it (no source calls at request time) and derives
the "All years" total itself.

- **Where it runs:** a Claude Code scheduled routine (cloud agent), *not* a
  Supabase edge function — same approach as `sales-topline-sync`.
- **Schedule:** weekly, **Monday 06:00 Asia/Manila** (`0 6 * * 1`, ≈ `0 22 * * 0`
  UTC). The source sheet is hand-updated roughly monthly (a new ad-spend month is
  typed in at the bottom), so weekly is ample.
- **Supabase project:** `aivitcomiywiysrfwqxt` (MAGTestProject). Writes via the
  Supabase MCP `execute_sql`.
- **Source of truth:** Google Sheet **"MAG Marketing ROAS Report – YTD - FY24-27
  deal"** (id `1nf80glgW7EeIIPtTKQBtQlUoZ16h8BqLJDkbihPR1Sc`), tab **"Year on
  Year" (CALENDAR YEAR)**. That tab blends sources the live DB can't reproduce:
  2022–2024 = previous manager's lead log; 2025+ = CRM rebuild (strict Google
  rule + MAG Buyer Analysis values, ex-GST); ad spend = Google/Microsoft Ads
  platform exports (Jul 2024+) and estimates before.

## Step 1 — read the "Year on Year" tab

Read two ranges (Google Sheets connector, or export the file as XLSX via the
Drive connector and parse — the sheet has merged title rows, so read by cell):

- **Main block** — header at **row 4**, one data row per year from **row 5**
  down to the year before the **"All years"** row (currently rows 5–9; `A` is the
  4-digit year, stop when `A` is blank or reads "All years"):

  | col | field | notes |
  |-----|-------|-------|
  | A | `cal_yr` | calendar year (int) |
  | B | `period_label` | e.g. "May – Dec 2022" |
  | C | `won_leads` | won deal count |
  | D | `lost_leads` | lost deal count |
  | E | `open_leads` | open deal count |
  | F | `leads` | total leads |
  | G | `win_rate` | ratio 0..1 |
  | H | `won_revenue` | AUD, ex-GST |
  | I | `ad_spend` | AUD (Google Ads) |
  | J | `roi_dollars` | AUD |
  | K | `roi_pct` | ratio (ROAS − 1) |
  | L | `roas` | × multiple |
  | M | `per_lead_value` | AUD |
  | N | `counted_method` | tooltip text |
  | O | `target_roas` | James's target (2.0) |

- **"Deal value by outcome (pipeline)" block** — header at **row 14**, data rows
  **15–19** (one per year), for the pipeline-value columns:

  | col | field |
  |-----|-------|
  | A | `cal_yr` (join key) |
  | B | `won_amount` (Won $) |
  | C | `lost_amount` (Lost $) |
  | D | `open_amount` (Open $) |

  Join to the main block on `cal_yr`. (`won_amount` currently equals
  `won_revenue` for every year, but read both — they are distinct columns in the
  report and may diverge.)

Skip the **"All years"** total row — the dashboard derives it.

## Step 2 — upsert into Supabase

For each year row, `execute_sql` an UPSERT (idempotent, keyed on `cal_yr`, never
truncates — a hand-edited year survives until the sheet re-writes it):

```sql
insert into public.roas_year_on_year
  (cal_yr, period_label, won_amount, lost_amount, open_amount,
   won_leads, lost_leads, open_leads, leads, win_rate,
   ad_spend, won_revenue, roi_dollars, roi_pct, roas, per_lead_value,
   counted_method, target_roas, updated_at)
values
  (:cal_yr, :period_label, :won_amount, :lost_amount, :open_amount,
   :won_leads, :lost_leads, :open_leads, :leads, :win_rate,
   :ad_spend, :won_revenue, :roi_dollars, :roi_pct, :roas, :per_lead_value,
   :counted_method, :target_roas, now())
on conflict (cal_yr) do update set
  period_label   = excluded.period_label,
  won_amount     = excluded.won_amount,
  lost_amount    = excluded.lost_amount,
  open_amount    = excluded.open_amount,
  won_leads      = excluded.won_leads,
  lost_leads     = excluded.lost_leads,
  open_leads     = excluded.open_leads,
  leads          = excluded.leads,
  win_rate       = excluded.win_rate,
  ad_spend       = excluded.ad_spend,
  won_revenue    = excluded.won_revenue,
  roi_dollars    = excluded.roi_dollars,
  roi_pct        = excluded.roi_pct,
  roas           = excluded.roas,
  per_lead_value = excluded.per_lead_value,
  counted_method = excluded.counted_method,
  target_roas    = excluded.target_roas,
  updated_at     = now();
```

Build a single multi-row `insert … values (…),(…),… on conflict …` from the parsed
rows (don't loop one statement per row). Treat blank/`#N/A` cells as NULL.

## Verify

```sql
select cal_yr, period_label, won_revenue, ad_spend, round(roas,2) roas, leads, updated_at
from public.roas_year_on_year order by cal_yr;
```

Expect one row per calendar year from 2022 to the current year, `updated_at` just
now, and `roas` tracking the report (2022 ≈ 10.40×, falling toward the 2.00×
target in recent years). If a **new calendar year** appears in the sheet, it is
inserted automatically — no dashboard code change needed; `roas.js` and the page
pick it up on the next load.

## Seeding / backfill

The initial 2022–2026 rows were seeded by migration
`supabase/migrations/20261020080000_roas_year_on_year.sql`. This routine keeps
them current and adds new years as the sheet grows.
