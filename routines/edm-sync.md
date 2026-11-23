# edm-sync — weekly EDM (ActiveCampaign) snapshot

Populates `public.edm_report_metrics`, the snapshot cache behind the Marketing
**EDM** page (`/api/marketing/edm` → `server/metrics/edm-report.js`). Same model
as `email-partners-sync`: a scheduled job writes a Supabase cache; the dashboard
only ever `SELECT`s the latest row. (The page's "new contacts by month" bar is
computed live by the server from `activecampaign_contacts` — this routine does
**not** write it.)

- **Where it runs:** a Claude Code scheduled routine (cloud agent) with the
  **ActiveCampaign MCP** + **Supabase MCP** — *not* a Supabase edge function (the
  contact/campaign figures come from the AC MCP, which only Claude can call).
- **Schedule:** weekly, **Monday 06:00 Asia/Manila** (`0 6 * * 1`) — same cadence
  as the other weekly syncs.
- **Supabase project:** `aivitcomiywiysrfwqxt` (MAGTestProject). Writes via the
  Supabase MCP `execute_sql` (service role).
- **APPEND-ONLY:** each run **INSERTs ONE row**. Never UPDATE, never DELETE, never
  TRUNCATE — the server reads the most recent `captured_at`.

## What feeds each piece (ActiveCampaign MCP)
| Field(s) | Source |
|---|---|
| `total_contacts` | `list_contacts { limit:1, status:-1 }` → `meta.total` (ANY status) |
| `active_contacts` | `list_contacts { limit:1, status:1 }` → `meta.total` (ACTIVE) |
| `nonactive_contacts` | `total_contacts − active_contacts` |
| `top_lists` | `list_lists { orders:{active_subscribers:"DESC"}, limit:5 }` → `[{name, active_subscribers}]` |
| `top_tags` | `list_tags { limit:100 }` + `{ limit:100, offset:100 }`, keep `tag` + `subscriber_count`, sort by `subscriber_count` DESC, take top 5 → `[{tag, subscriber_count}]` |
| `camp_*` summary | `run_campaign_performance_report` → `summaryData` (see below) |
| `campaigns` | same report → `data[]`, one object per campaign (see shape) |

> **Contact statuses:** ANY=-1, UNCONFIRMED=0, ACTIVE=1, UNSUBSCRIBED=2, BOUNCED=3.
> `list_contacts` is capped at **one call per turn** by the MCP — run the two
> status counts across two turns.

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
reads them):
```
{ id, name, type, lastSent,            // lastSent = last_sent_date truncated to YYYY-MM-DD
  sends, uOpens, openRate, uClicks, clickRate, cto,
  bounces, bounceRate, unsubs, unsubRate }
```
(`uOpens`=unique_total_opens, `uClicks`=unique_subscriber_clicks,
`cto`=click_to_open_rate; the rest map by name.)

## Step 2 — insert the snapshot (Supabase MCP `execute_sql`)
ONE statement. Pass the `top_lists` / `top_tags` / `campaigns` arrays as JSON
literals cast to `jsonb`. **No `ON CONFLICT`, never UPDATE/DELETE.**

```sql
insert into public.edm_report_metrics (
  run_id, total_contacts, active_contacts, nonactive_contacts, top_lists, top_tags,
  camp_count, camp_total_sends, camp_open_rate, camp_click_rate, camp_click_to_open_rate,
  camp_bounce_rate, camp_unsubscribe_rate, camp_total_unique_opens, camp_total_unique_clicks,
  camp_total_bounces, camp_total_unsubscribes, campaigns, note
) values (
  gen_random_uuid(), <TOTAL>, <ACTIVE>, <NONACTIVE>,
  '<TOP_LISTS_JSON>'::jsonb, '<TOP_TAGS_JSON>'::jsonb,
  <CAMP_COUNT>, <TOTAL_SENDS>, <OPEN_RATE>, <CLICK_RATE>, <CTO_RATE>,
  <BOUNCE_RATE>, <UNSUB_RATE>, <UNIQUE_OPENS>, <UNIQUE_CLICKS>,
  <TOTAL_BOUNCES>, <TOTAL_UNSUBS>, '<CAMPAIGNS_JSON>'::jsonb, 'weekly edm-sync'
);
```

## Verify
```sql
select total_contacts, active_contacts, nonactive_contacts,
       jsonb_array_length(top_lists)  as n_lists,
       jsonb_array_length(top_tags)   as n_tags,
       camp_count, camp_total_sends, camp_open_rate,
       jsonb_array_length(campaigns)  as n_campaigns, captured_at
from public.edm_report_metrics
order by captured_at desc limit 1;
```

## Notes & gotchas
- **AC MCP aggregates:** `run_campaign_performance_report` IS the sanctioned
  aggregate tool — its `summaryData` is account-level. Do **not** sum
  `list_campaigns` rows by hand (the MCP rejects that).
- **Top tags need two pages** (`limit:100` then `offset:100`); the account has
  ~192 tags. Each tag record carries `subscriber_count` — sort on it client-side
  (the MCP can't order tags by count).
- **Top lists** sort server-side (`orders.active_subscribers=DESC`) — one call.
- **Open rate is inflated** by Apple Mail privacy — it's stored as reported but the
  page notes the caveat; clicks are the reliable signal.
- The page's **new-contacts-by-month** chart is live from
  `activecampaign_contacts` (daily-synced mirror) — not written here.
- Frontend/server for this page ship with the dashboard — a *data* refresh here
  needs **no redeploy** (the server only SELECTs the cache).
```
