# sales-topline-sync — weekly Sales Top-Line KPI refresh

Populates `public.sales_topline`, the cache behind the dashboard **Sales** page
(`/api/sales/topline` → `server/metrics/sales-topline.js`). This mirrors the
Conferences/Invoices model: a scheduled job fills a Supabase cache table; the
dashboard only ever `SELECT`s it (no source calls at request time).

- **Where it runs:** a Claude Code scheduled routine (cloud agent), *not* a
  Supabase edge function — same approach as the invoice-tracking sync.
- **Schedule:** weekly, **Monday 06:00 Asia/Manila** (`0 6 * * 1`, TZ
  Asia/Manila ≈ `0 22 * * 0` UTC).
- **Supabase project:** `aivitcomiywiysrfwqxt` (MAGTestProject). Writes via the
  Supabase MCP `execute_sql` (service role).
- **Source of truth for KPIs:** MAG_Sales_Metrics Google Sheet, `dev_sheet` tab,
  rows 2-8 (the "Top-Line Header" group).

## KPIs & mappings (resolved against ActiveCampaign)
| metric | dev_sheet row | computed from |
|--------|---------------|---------------|
| `total_income` | 2 — Total Income by Year (YTD) | `invoice_tracking.amount_total`, `lower(currency)='aud'` |
| `direct_indirect_split` | 3 — Direct vs Indirect (%) | ⚠ AC **"Deal Source?"** custom field — not yet mirrored |
| `speaking_enquiries` | 4 — Speaking Enquiries / month | ⚠ AC tag **"[SALES] Inbound Enquiry"** — not yet mirrored |
| `bureau` | 5 — Bureau | `activecampaign_deals."group"='3'` (LIV pipeline) **stage `'113'`** (BUREAU ENQUIRY) |
| `tailor` | 6 — Tailor | `activecampaign_deals."group"='7'` (The Tailor pipeline) |
| `inbound` | 7 — inbound | ⚠ AC **"Inbound/ Outbound?"** field = Inbound Enquiry — not yet mirrored |
| `outbound` | 8 — outbound | ⚠ AC **"Inbound/ Outbound?"** field = Outbound* — not yet mirrored |

LIV pipeline = dealGroup `3` "Keynotes // Workshops // Immersive (LIV)";
BUREAU ENQUIRY = dealStage `113`; The Tailor = dealGroup `7`.

## Step 1 — compute + upsert the Supabase-derived metrics (live today)
Run this SQL via Supabase MCP each Monday. Idempotent (UPSERT on PK), 12-month
window, never truncates.

```sql
-- total_income: current-year YTD (AUD)
insert into public.sales_topline(metric,bucket,dimension,value,unit,updated_at)
select 'total_income', date_trunc('year',current_date)::date, 'ytd',
       coalesce(sum(amount_total),0), 'aud', now()
from public.invoice_tracking
where lower(currency)='aud'
  and invoice_date >= date_trunc('year',current_date)::date
  and invoice_date <  (date_trunc('year',current_date)+interval '1 year')::date
on conflict (metric,bucket,dimension) do update set value=excluded.value,unit=excluded.unit,updated_at=now();

-- total_income: prior-year to same date (AUD) for the delta
insert into public.sales_topline(metric,bucket,dimension,value,unit,updated_at)
select 'total_income', (date_trunc('year',current_date)-interval '1 year')::date, 'ytd_prev',
       coalesce(sum(amount_total),0), 'aud', now()
from public.invoice_tracking
where lower(currency)='aud'
  and invoice_date >= (date_trunc('year',current_date)-interval '1 year')::date
  and invoice_date <  (current_date-interval '1 year')::date
on conflict (metric,bucket,dimension) do update set value=excluded.value,unit=excluded.unit,updated_at=now();

-- total_income: monthly series, last 12 months (AUD)
insert into public.sales_topline(metric,bucket,dimension,value,unit,updated_at)
select 'total_income', date_trunc('month',invoice_date)::date, '',
       coalesce(sum(amount_total),0), 'aud', now()
from public.invoice_tracking
where lower(currency)='aud'
  and invoice_date >= (date_trunc('month',current_date)-interval '11 months')::date
group by 2
on conflict (metric,bucket,dimension) do update set value=excluded.value,unit=excluded.unit,updated_at=now();

-- bureau: monthly new-deal counts, LIV pipeline (group 3) stage 113, last 12 months
insert into public.sales_topline(metric,bucket,dimension,value,unit,updated_at)
select 'bureau', date_trunc('month',cdate)::date, '', count(*), 'count', now()
from public.activecampaign_deals
where "group"='3' and stage='113'
  and cdate >= (date_trunc('month',current_date)-interval '11 months')
group by 2
on conflict (metric,bucket,dimension) do update set value=excluded.value,unit=excluded.unit,updated_at=now();

-- tailor: monthly new-deal counts, The Tailor pipeline (group 7), last 12 months
insert into public.sales_topline(metric,bucket,dimension,value,unit,updated_at)
select 'tailor', date_trunc('month',cdate)::date, '', count(*), 'count', now()
from public.activecampaign_deals
where "group"='7'
  and cdate >= (date_trunc('month',current_date)-interval '11 months')
group by 2
on conflict (metric,bucket,dimension) do update set value=excluded.value,unit=excluded.unit,updated_at=now();
```

Notes:
- Income sums **AUD only** (one historical USD invoice is excluded); revisit if
  multi-currency reporting is needed.
- Bureau/Tailor are bucketed by **created date** (`cdate`) — "new deals per
  month", since the mirror has no stage-entry history.

## Step 2 — backfill the AC-only metrics (TODO; currently "needs setup")
`direct_indirect_split`, `speaking_enquiries`, `inbound`, `outbound` depend on AC
data not yet in Supabase, so they render as "needs setup" tiles. To light them up,
the routine should pull from ActiveCampaign (MCP or API) and upsert rows:
- **"Deal Source?"** and **"Inbound/ Outbound?"** deal custom-field values
  (resolve field ids via AC custom-deal-field meta; join won deals to
  `invoice_tracking` for the income split), writing `direct_indirect_split`
  (dimension `direct`/`indirect`, unit `pct`/`aud`) and `inbound`/`outbound`
  (monthly, unit `count`).
- **"[SALES] Inbound Enquiry"** tag → monthly tagged-contact/deal counts →
  `speaking_enquiries` (unit `count`).
Either mirror these into Supabase first (preferred — keeps the dashboard a pure
SELECT) or compute in the routine and upsert the aggregates directly. Once rows
exist, `server/metrics/sales-topline.js` picks them up automatically and the
tiles flip from "needs setup" to live — no dashboard code change needed.

## Verify
```sql
select metric, dimension, count(*) rows, sum(value) total,
       min(bucket) mn, max(bucket) mx
from public.sales_topline group by 1,2 order by 1,2;
```
