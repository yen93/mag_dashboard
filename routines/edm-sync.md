# edm-sync — daily EDM (ActiveCampaign) snapshot

Populates `public.edm_report_metrics`, the snapshot cache behind the Marketing
**EDM** page (`/api/marketing/edm` → `server/metrics/edm-report.js`). Same model
as `email-partners-sync`: a scheduled job writes a Supabase cache; the dashboard
only ever `SELECT`s the latest row.

- **Where it runs:** a Claude Code scheduled routine (cloud agent) with the
  **ActiveCampaign MCP** + **Supabase MCP** — *not* a Supabase edge function (the
  contact/campaign figures come from the AC MCP, which only Claude can call).
- **Schedule:** daily, **06:00 Asia/Manila** (`0 22 * * *` UTC).
- **Supabase project:** `aivitcomiywiysrfwqxt` (MAGTestProject). Writes via the
  Supabase MCP `execute_sql` (service role).
- **APPEND-ONLY:** each run **INSERTs ONE row**. Never UPDATE, DELETE or TRUNCATE —
  the server reads the most recent `captured_at`.

## What feeds each piece (ActiveCampaign MCP)
| Field(s) | Source |
|---|---|
| `total_contacts` | `list_contacts { limit:1, status:-1 }` → `meta.total` (ANY status) |
| `active_contacts` | `list_contacts { limit:1, status:1 }` → `meta.total` (ACTIVE) |
| `nonactive_contacts` | `total_contacts − active_contacts` |
| `top_lists` (List health) | `list_lists { limit:30 }`, sort by **`non_deleted_subscribers` (total) DESC**, take top 5 → `[{name, active, total}]` where `active`=`active_subscribers`, `total`=`non_deleted_subscribers` |
| `segmentation` | `list_tags { limit:100 }` + `{ limit:100, offset:100 }`; pick the three engagement tags by exact name (below) and read each `subscriber_count` → `[{key,label,count,tag,desc}]` |
| `camp_*` summary | `run_campaign_performance_report` → `summaryData` (see Step 1) |
| `campaigns` | same report → `data[]`, one object per campaign (see shape) |

> `list_contacts` is capped at **one call per turn** by the MCP — run the two
> status counts across two turns. Statuses: ANY=-1, UNCONFIRMED=0, ACTIVE=1,
> UNSUBSCRIBED=2, BOUNCED=3. **`top_tags` is unused** (leave it `'[]'`).

> **`list_tags` GOTCHA (seen 2026-11-25):** the MCP ignores `limit`/`offset`/filters
> and always returns the FIRST 20 of ~192 tags, so the three engagement tags can't
> be found by paging. **Fallback (do this instead of skipping the run):** try
> `list_tags` once; if none of the three names appear, **carry forward the previous
> snapshot's `segmentation`** with
> `select segmentation from public.edm_report_metrics order by captured_at desc limit 1`
> and reuse it verbatim (counts are slightly stale, which beats no snapshot). Never
> invent counts. Once a tag id is known, `get_tag { id }` returns its
> `subscriber_count` directly - record the ids here when found.

### Engagement segmentation tags (fixed)
Build `segmentation` as exactly these three, in order, reading each tag's
`subscriber_count` (0 is valid):
```
{ "key":"active",  "label":"Engaged", "tag":"[MARKETING] engagement: active",
  "desc":"Opened something in the last 90 days" }
{ "key":"quiet",   "label":"Quiet",   "tag":"[MARKETING] engagement: quiet 90d",
  "desc":"No open 90-180 days (re-engagement flow audience)" }
{ "key":"dormant", "label":"Dormant", "tag":"[MARKETING] engagement: dormant 180d",
  "desc":"No open 180+ days (reduced cadence)" }
```

## Step 1 — campaign report (ActiveCampaign MCP)

### 1a — all-time report (backward-compatible, feeds the camp_* columns)
ONE call, **all-time** (no date params — `summaryData` then covers every sent
campaign):

```
run_campaign_performance_report({
  module: "campaigns",
  explore: "all_campaigns_performance",
  columns: ["campaign_id","campaign_name","campaign_type","last_sent_date",
            "total_sends","unique_total_opens","open_rate",
            "unique_subscriber_clicks","click_rate","click_to_open_rate",
            "total_bounces","bounce_rate","total_unsubscribes","unsubscribe_rate"],
  sorts: [{ column: "total_sends", order: "DESC" }],
  limit: 400
})
```

From `summaryData`: `number_of_campaigns`→`camp_count`, `total_sends`,
`open_rate`, `click_rate`, `click_to_open_rate`, `bounce_rate`,
`unsubscribe_rate`, `total_unique_opens`, `total_unique_clicks`, `total_bounces`,
`total_unsubscribes`.

Map each `data[]` row to this campaign object (keep these keys exactly — the page
reads them): `{ id, name, type, lastSent, sends, uOpens, openRate, uClicks,
clickRate, cto, bounces, bounceRate, unsubs, unsubRate }` (`lastSent` =
`last_sent_date` truncated to `YYYY-MM-DD`; `uOpens`=unique_total_opens,
`uClicks`=unique_subscriber_clicks, `cto`=click_to_open_rate; the rest map by name).

### 1b — per-window reports (feeds campaign_windows JSONB)
Run `run_campaign_performance_report` **once per window** with `params` to get
AC's own date-scoped `summaryData` and `data[]` for each. Use the same `columns`,
`sorts`, `limit: 400` as above, but add:

```
params: {
  view_distinct_campaigns_event_date_start: "<YYYY-MM-DD>",
  view_distinct_campaigns_event_date_end:   "<YYYY-MM-DD>"
}
```

Windows to compute (all dates use the routine run date as "today"):

| Key   | Start date          | End date              |
|-------|--------------------|-----------------------|
| `all` | *(skip — use 1a)*  | *(skip — use 1a)*     |
| `fy22`| `2021-07-01`       | `2022-06-30`          |
| `fy23`| `2022-07-01`       | `2023-06-30`          |
| `fy24`| `2023-07-01`       | `2024-06-30`          |
| `fy25`| `2024-07-01`       | `2025-06-30`          |
| `fy26`| `2025-07-01`       | `2026-06-30`          |
| `fy27`| `2026-07-01`       | today                 |
| `qtd` | first day of the current calendar quarter (e.g. 2026-10-01) | today |
| `30d` | today − 30 days    | today                 |
| `90d` | today − 90 days    | today                 |
| `12m` | today − 365 days   | today                 |

For each window, from the response extract:
- `summaryData` → `summary` object with these keys: `{ count, totalSends,
  openRate, clickRate, clickToOpenRate, bounceRate, unsubscribeRate,
  totalUniqueOpens, totalUniqueClicks, totalBounces, totalUnsubscribes }`
  (map `number_of_campaigns` → `count`, the rest by name).
- `data[]` → `campaigns` array, same shape as step 1a.
- Store each as `{ summary, campaigns, from: "<start>", to: "<end>" }`.

Build a JSON object keyed by window name. Also insert the `all` key using the
all-time `summaryData`/`data[]` from step 1a:
```json
{
  "all":  { "summary": {…}, "campaigns": [{…}], "from": null, "to": null },
  "fy22": { "summary": {…}, "campaigns": [{…}], "from": "2021-07-01", "to": "2022-06-30" },
  ...
  "30d":  { "summary": {…}, "campaigns": [{…}], "from": "2026-10-26", "to": "2026-11-25" }
}
```

> **Payload size (MANDATORY - a full run failed on this 2026-11-25):** inline
> reports of 300+ campaigns can't be retyped into one SQL string. So for every
> WINDOWED call use `limit: 50` (sorted `total_sends DESC`) and only these columns:
> `campaign_id, campaign_name, campaign_type, last_sent_date, total_sends,
> unique_total_opens, unique_subscriber_clicks, total_bounces, total_unsubscribes`
> (derive the rates client-side or drop them). `summaryData` is always account-level
> for the whole window, so the KPIs stay exact even when `campaigns[]` is trimmed.
> For the `all` key and the legacy `campaigns` column also keep only the top 50.
> Build the INSERT from **compact JSON** (no whitespace). If the combined statement
> is still too large, drop `campaigns[]` for the `fy22`-`fy24` windows (keep their
> `summary`) rather than abandoning the run.

> **Rate limit:** AC MCP allows ~5 req/s. Run at most 2–3 window calls per turn
> to stay safe. This means spreading the 9 windowed calls across 3–5 turns.

## Step 2 — insert the snapshot (Supabase MCP `execute_sql`)
ONE statement. Pass `top_lists` / `segmentation` / `campaigns` /
`campaign_windows` as JSON literals cast to `jsonb`.
**No `ON CONFLICT`, never UPDATE/DELETE.**

```sql
insert into public.edm_report_metrics (
  run_id, total_contacts, active_contacts, nonactive_contacts, top_lists, segmentation,
  camp_count, camp_total_sends, camp_open_rate, camp_click_rate, camp_click_to_open_rate,
  camp_bounce_rate, camp_unsubscribe_rate, camp_total_unique_opens, camp_total_unique_clicks,
  camp_total_bounces, camp_total_unsubscribes, campaigns, campaign_windows, note
) values (
  gen_random_uuid(), <TOTAL>, <ACTIVE>, <NONACTIVE>,
  '<TOP_LISTS_JSON>'::jsonb, '<SEGMENTATION_JSON>'::jsonb,
  <CAMP_COUNT>, <TOTAL_SENDS>, <OPEN_RATE>, <CLICK_RATE>, <CTO_RATE>,
  <BOUNCE_RATE>, <UNSUB_RATE>, <UNIQUE_OPENS>, <UNIQUE_CLICKS>,
  <TOTAL_BOUNCES>, <TOTAL_UNSUBS>, '<CAMPAIGNS_JSON>'::jsonb,
  '<CAMPAIGN_WINDOWS_JSON>'::jsonb, 'daily edm-sync'
);
```

## Verify
```sql
select total_contacts, active_contacts, nonactive_contacts,
       jsonb_array_length(top_lists)    as n_lists,
       jsonb_array_length(segmentation) as n_seg,
       camp_count, camp_total_sends, camp_open_rate,
       jsonb_array_length(campaigns)    as n_campaigns,
       jsonb_object_keys(campaign_windows) as window_keys,
       captured_at
from public.edm_report_metrics
order by captured_at desc limit 1;
```

Also verify a specific window matches AC:
```sql
select campaign_windows->'fy27'->'summary' as fy27_summary,
       jsonb_array_length(campaign_windows->'fy27'->'campaigns') as fy27_n
from public.edm_report_metrics
order by captured_at desc limit 1;
```

## Notes & gotchas
- **Schedule is DAILY** (`0 22 * * *` UTC = 06:00 Manila every day) so rolling
  windows (30d/90d/12m) stay fresh and campaigns sent today appear tomorrow.
- **AC MCP aggregates:** `run_campaign_performance_report` IS the sanctioned
  aggregate tool — its `summaryData` is account-level for the window. The `params`
  `view_distinct_campaigns_event_date_start` / `view_distinct_campaigns_event_date_end`
  scope both `summaryData` and `data[]` to the window (the same way the AC UI's
  "Campaigns Performance" date filter works). Do **not** sum `list_campaigns` rows
  by hand (the MCP rejects that).
- **campaign_windows is the primary data path.** The camp_* columns and campaigns
  JSONB are kept for backward compatibility but the page prefers campaign_windows.
- **List health** needs each list's **total** (`non_deleted_subscribers`), which
  `list_lists` can't sort by — fetch all (~23) and sort client-side by total DESC.
- **Segmentation tags may read 0** (quiet/dormant) when the AC engagement
  automation hasn't tagged anyone in that band — that's a real value, keep it.
- **Open rate is inflated** by Apple Mail privacy — stored as reported; the page
  notes the caveat, clicks are the reliable signal.
- Frontend/server for this page ship with the dashboard — a *data* refresh here
  needs **no redeploy** (the server only SELECTs the cache).
```
