-- Exec X revenue — a STATIC one-time load of the "Executive X ROI Report" Google Sheet
-- (spreadsheet 1GO5hCbI4l0Jpn9GelbWeI61mM6A4NOiH0Qp_OdnonFg), one row per REVENUE line
-- across the six season tabs. Feeds the Marketing Revenue card on the ROI tab
-- (server/metrics/marketing-roi.js → /api/marketing/roi).
--
-- The dashboard has no live Google Sheets access, so this is a hand-seeded table like
-- niki_ad_leads_tracking / clover_audited_deals. Re-run this seed (or UPSERT new rows) when
-- the sheet changes.
--
-- fy_end = AU financial-year END year (Jul–Jun) of the EVENT date, since Exec X revenue is
-- realized when the booked event runs (the season tab name is the cohort, not the revenue FY).
-- The one line with no event date (Chandler Mcleod, Spring 2023 cohort) is assigned to the
-- cohort's FY (FY24). Per-line revenue reconciles to each tab's REVENUE total, and the FY
-- totals are FY24 $10,000 · FY25 $113,255 · FY26 $177,315 · FY27 $22,450 (grand total $323,020).

CREATE TABLE IF NOT EXISTS public.exec_x_revenue (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season      text    NOT NULL,          -- source tab name (cohort), e.g. 'SPRING 2023'
  company     text,                      -- client company
  client      text,                      -- client contact name
  revenue     numeric NOT NULL,          -- AUD revenue from this engagement
  event_text  text,                      -- raw EVENT cell (date + type), null when blank
  fy_end      integer NOT NULL,          -- AU FY end-year of the event date (cohort year if undated)
  loaded_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.exec_x_revenue IS
  'Static one-time load of the Executive X ROI Report Google Sheet (per REVENUE line). '
  'fy_end = AU FY end-year of the event date. Re-seed when the sheet changes.';

-- Idempotent reseed: clear then insert the full set.
DELETE FROM public.exec_x_revenue;

INSERT INTO public.exec_x_revenue (season, company, client, revenue, event_text, fy_end) VALUES
  ('SPRING 2023',       'Chandler Mcleod Group',        'Jamie Devitt',      10000, NULL,                                              2024),
  ('SPRING 2023',       'Scenic World Blue Mountains',  'Jason Cronshaw',     2000, 'March 26, 2025 - Keynote',                        2025),
  ('SPRING 2023',       'Reckon',                       'Sam Allert',        36400, 'December 2, 2025 - Immersive; December 4-5, 2025 - Offsite', 2026),
  ('AUTUMN 2024',       'National Tiles',               'Simon Duggan',      37315, 'March 10-11, 2025 - Offsite',                     2025),
  ('AUTUMN 2024',       'Mammoth Projects',             'Daniel Ryan',       22740, 'November 4-5, 2024 - Offsite',                    2025),
  ('AUTUMN 2024',       'Mammoth Projects',             'Scott Alexander',   33915, 'November 2-4, 2025 - Offsite',                    2026),
  ('SPRING 2024',       'Purpa',                        'Chris Black',        4500, 'May 2, 2025 - Keynote',                           2025),
  ('MAR - AUTUMN 2025', 'One Ventures',                 'Matt Sinnamon',     40500, 'March 17-19, 2025 - Offsite',                     2025),
  ('MAR - AUTUMN 2025', 'Entrepreneurs'' Organization', 'Jane Bianchini',    52500, 'November 26-28, 2025 - Offsite',                  2026),
  ('MAR - AUTUMN 2025', 'GPC Asia Pacific',             'Tanya Law',         12500, 'May 26, 2026 - Immersive',                        2026),
  ('MAR - AUTUMN 2025', 'Celebrity Speakers',           'David Maher',        6200, 'May 8, 2025 - Keynote',                           2025),
  ('NOV - SPRING 2025', 'Flying Ruby',                  'Kelly Lewis',       11950, 'October 30, 2026 - Offsite',                      2027),
  ('NOV - SPRING 2025', 'AV Partners',                  'Elizabeth Moody',    8500, 'August 29, 2026 - Keynote',                       2027),
  ('NOV - SPRING 2025', 'ART',                          'Patrick Twomey',    19000, 'May 19 and 21, 2026 - Immersive',                 2026),
  ('NOV - SPRING 2025', 'Sydney Water',                 'Dinesh Dineshharan',10500, 'May 7, 2026 - Workshop',                          2026),
  ('MAR - AUTUMN 2026', 'YPO',                          'Lachlan Cameron',   12500, 'April 30, 2026 - Immersive',                      2026),
  ('MAR - AUTUMN 2026', 'Vistage',                      'Tony Chamberlain',   2000, 'August 18-19, 20-26 - Keynote',                   2027);
