# simple-digital-fees-sync — monthly Simple Digital fee refresh

Populates `public.simple_digital_fees_monthly`, the Simple Digital half of the
dashboard **ROAS** page's All-in ad-spend basis (FY25+). The ROAS metric
(`server/metrics/roas.js`) only ever `SELECT`s this table (a LEFT JOIN), so until
this routine runs the Simple Digital fee simply reads $0.

- **Where it runs:** a Claude Code scheduled routine (cloud agent), using the
  **Gmail MCP** — same approach as `sales-topline-sync` / `invoice-tracking` (not an
  edge function, so no Gmail service account is needed).
- **Schedule:** monthly, **1st of the month 06:00 Asia/Manila** (`0 6 1 * *`,
  ≈ `0 22 L * *` UTC). Debits recur monthly; a monthly run with a lookback is plenty.
- **Supabase project:** `aivitcomiywiysrfwqxt` (MAGTestProject). Writes via the
  Supabase MCP `execute_sql` (service role).
- **Source of truth:** GoCardless "Upcoming Direct Debit payment to Simple Digital
  Pty Ltd" notices in Gmail (mirrors the artifact's Gmail read).

## What each notice gives us
Search Gmail (last ~120 days, or `all` on a first backfill):

```
from:gocardless.com "Simple Digital" subject:"Upcoming Direct Debit"
```

Each message body contains a line like:

```
… charging you AU$1,320.00 for Invoice INV-1234 …
```

From each notice take: the **amount inc GST** (`AU$<amount>`), the **invoice number**
(`INV-\d+`), and the **notice date** (the message date → its `YYYY-MM` month).

## Derivation (per month)
- `amount_inc_gst` = the AU$ figure on the notice.
- `amount_ex_gst`  = `amount_inc_gst / 1.1`.
- `seo_component`  = `600` for months **from 2026-03 onward**, else `0`
  (from Mar 2026 $600 of each invoice is SEO and sits OUTSIDE paid-search ROAS).
- `paid_search_fee` = `amount_ex_gst - seo_component`  ← this is the ROAS cost.

If a month has several invoices, sum their inc-GST amounts first, then derive.

## Step — upsert (idempotent, UPSERT on PK `month`; never truncates)
For each month parsed from the notices, run via Supabase MCP:

```sql
insert into public.simple_digital_fees_monthly
  (month, invoice, notice_date, amount_inc_gst, amount_ex_gst, seo_component, paid_search_fee, updated_at)
values
  (:month, :invoice_list, :notice_date, :amount_inc_gst,
   round(:amount_inc_gst / 1.1, 2),
   case when :month >= date '2026-03-01' then 600 else 0 end,
   round(:amount_inc_gst / 1.1, 2) - case when :month >= date '2026-03-01' then 600 else 0 end,
   now())
on conflict (month) do update set
  invoice = excluded.invoice,
  notice_date = excluded.notice_date,
  amount_inc_gst = excluded.amount_inc_gst,
  amount_ex_gst = excluded.amount_ex_gst,
  seo_component = excluded.seo_component,
  paid_search_fee = excluded.paid_search_fee,
  updated_at = now();
```

`month` is the first of the notice's month (e.g. `2026-10-01`); `invoice` is the
comma-joined invoice number(s) for that month.

## Notes
- The ROAS page's "Ad spend by month" source sheet records Simple Digital from ~Jun 2023
  ($920/mo, later $1,320/mo). The live Gmail notices only go back as far as the mailbox
  retains them — a one-time historical backfill of pre-mailbox months (from that sheet) can
  be loaded directly into this table if FY25 needs the earlier Simple Digital figures.
- Only the **paid-search** component counts as ROAS cost; the SEO component is excluded by design.
