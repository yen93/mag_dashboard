-- edm_report_metrics: add campaign_windows JSONB column.
--
-- The existing camp_* columns and campaigns JSONB store ALL-TIME lifetime totals.
-- When the frontend filters by FY or a date range, the lifetime totals are wrong
-- (they include activity outside the window).
--
-- campaign_windows stores pre-computed per-window summaries and campaign rows
-- from AC's run_campaign_performance_report with date params, keyed by window:
--   "all"  — no date filter (matches the existing camp_* columns)
--   "fy22" – "fy27" — Australian FY windows (Jul–Jun)
--   "30d", "90d", "12m" — rolling windows relative to the routine run date
--
-- Each value:
--   { "summary": { count, totalSends, openRate, clickRate, clickToOpenRate,
--                  bounceRate, unsubscribeRate, totalUniqueOpens,
--                  totalUniqueClicks, totalBounces, totalUnsubscribes },
--     "campaigns": [ { id, name, type, lastSent, sends, uOpens, openRate,
--                      uClicks, clickRate, cto, bounces, bounceRate,
--                      unsubs, unsubRate } ],
--     "from": "YYYY-MM-DD",   -- window start (null for "all")
--     "to":   "YYYY-MM-DD" }  -- window end   (null for "all")
--
-- The edm-sync routine (routines/edm-sync.md) populates this; the server
-- (edm-report.js) returns it; the frontend (edm.html) reads the matching
-- window directly instead of filtering all-time data by lastSent.

ALTER TABLE public.edm_report_metrics
  ADD COLUMN IF NOT EXISTS campaign_windows jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.edm_report_metrics.campaign_windows IS
  'Per-window campaign performance from AC run_campaign_performance_report with date '
  'params. Keys: all, fy22–fy27, 30d, 90d, 12m. See migration 20261125150000.';
