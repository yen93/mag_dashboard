# edm-sync — weekly EDM (ActiveCampaign) snapshot

Populates `public.edm_report_metrics`, the snapshot cache behind the Marketing
**EDM** page (`/api/marketing/edm` → `server/metrics/edm-report.js`). Same model
as `email-partners-sync`: a scheduled job writes a Supabase cache; the dashboard
only ever `SELECT`s the latest row.

- **Where it runs:** a Claude Code scheduled routine (cloud agent) with the
  **ActiveCampaign MCP** + **Supabase MCP** — *not* a Supabase edge function (the
  contact/campaign figures come from the AC MCP, which only Claude can call).
- **Schedule:** weekly, **Monday 06:00 Asia/Manila** (`0 22 * * 0` UTC).
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

## Step 2 — insert the snapshot (Supabase MCP `execute_sql`)
ONE statement. Pass `top_lists` / `segmentation` / `campaigns` as JSON literals
cast to `jsonb`. **No `ON CONFLICT`, never UPDATE/DELETE.**

```sql
insert into public.edm_report_metrics (
  run_id, total_contacts, active_contacts, nonactive_contacts, top_lists, segmentation,
  camp_count, camp_total_sends, camp_open_rate, camp_click_rate, camp_click_to_open_rate,
  camp_bounce_rate, camp_unsubscribe_rate, camp_total_unique_opens, camp_total_unique_clicks,
  camp_total_bounces, camp_total_unsubscribes, campaigns, note
) values (
  gen_random_uuid(), <TOTAL>, <ACTIVE>, <NONACTIVE>,
  '<TOP_LISTS_JSON>'::jsonb, '<SEGMENTATION_JSON>'::jsonb,
  <CAMP_COUNT>, <TOTAL_SENDS>, <OPEN_RATE>, <CLICK_RATE>, <CTO_RATE>,
  <BOUNCE_RATE>, <UNSUB_RATE>, <UNIQUE_OPENS>, <UNIQUE_CLICKS>,
  <TOTAL_BOUNCES>, <TOTAL_UNSUBS>, '<CAMPAIGNS_JSON>'::jsonb, 'weekly edm-sync'
);
```

## Verify
```sql
select total_contacts, active_contacts, nonactive_contacts,
       jsonb_array_length(top_lists)    as n_lists,
       jsonb_array_length(segmentation) as n_seg,
       camp_count, camp_total_sends, camp_open_rate,
       jsonb_array_length(campaigns)    as n_campaigns, captured_at
from public.edm_report_metrics
order by captured_at desc limit 1;
```

## Notes & gotchas
- **AC MCP aggregates:** `run_campaign_performance_report` IS the sanctioned
  aggregate tool — its `summaryData` is account-level. Do **not** sum
  `list_campaigns` rows by hand (the MCP rejects that).
- **List health** needs each list's **total** (`non_deleted_subscribers`), which
  `list_lists` can't sort by — fetch all (~23) and sort client-side by total DESC.
- **Segmentation tags may read 0** (quiet/dormant) when the AC engagement
  automation hasn't tagged anyone in that band — that's a real value, keep it.
- **Open rate is inflated** by Apple Mail privacy — stored as reported; the page
  notes the caveat, clicks are the reliable signal.
- Frontend/server for this page ship with the dashboard — a *data* refresh here
  needs **no redeploy** (the server only SELECTs the cache).
```
