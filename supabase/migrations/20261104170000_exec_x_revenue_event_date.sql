-- Add a parsed event_date to exec_x_revenue so the ROI tab's "Revenue vs spend by month" chart can
-- place each Exec X engagement's revenue in the right calendar month (the marketing-revenue line).
-- event_date = the first date in each REVENUE line's EVENT cell. The one undated line (Chandler
-- Mcleod, Spring 2023 cohort) gets a NOMINAL cohort-season date (Oct 2023) so it still lands in its
-- FY24 month bucket and the monthly series reconciles to the per-FY totals. Every event_date's AU FY
-- matches the row's stored fy_end. Re-apply these UPDATEs if the exec_x_revenue seed is refreshed.

ALTER TABLE public.exec_x_revenue ADD COLUMN IF NOT EXISTS event_date date;

UPDATE public.exec_x_revenue SET event_date = '2023-10-01' WHERE company = 'Chandler Mcleod Group' AND revenue = 10000;
UPDATE public.exec_x_revenue SET event_date = '2025-03-26' WHERE company = 'Scenic World Blue Mountains' AND revenue = 2000;
UPDATE public.exec_x_revenue SET event_date = '2025-12-02' WHERE company = 'Reckon' AND revenue = 36400;
UPDATE public.exec_x_revenue SET event_date = '2025-03-10' WHERE company = 'National Tiles' AND revenue = 37315;
UPDATE public.exec_x_revenue SET event_date = '2024-11-04' WHERE company = 'Mammoth Projects' AND revenue = 22740;
UPDATE public.exec_x_revenue SET event_date = '2025-11-02' WHERE company = 'Mammoth Projects' AND revenue = 33915;
UPDATE public.exec_x_revenue SET event_date = '2025-05-02' WHERE company = 'Purpa' AND revenue = 4500;
UPDATE public.exec_x_revenue SET event_date = '2025-03-17' WHERE company = 'One Ventures' AND revenue = 40500;
UPDATE public.exec_x_revenue SET event_date = '2025-11-26' WHERE company = 'Entrepreneurs'' Organization' AND revenue = 52500;
UPDATE public.exec_x_revenue SET event_date = '2026-05-26' WHERE company = 'GPC Asia Pacific' AND revenue = 12500;
UPDATE public.exec_x_revenue SET event_date = '2025-05-08' WHERE company = 'Celebrity Speakers' AND revenue = 6200;
UPDATE public.exec_x_revenue SET event_date = '2026-10-30' WHERE company = 'Flying Ruby' AND revenue = 11950;
UPDATE public.exec_x_revenue SET event_date = '2026-08-29' WHERE company = 'AV Partners' AND revenue = 8500;
UPDATE public.exec_x_revenue SET event_date = '2026-05-19' WHERE company = 'ART' AND revenue = 19000;
UPDATE public.exec_x_revenue SET event_date = '2026-05-07' WHERE company = 'Sydney Water' AND revenue = 10500;
UPDATE public.exec_x_revenue SET event_date = '2026-04-30' WHERE company = 'YPO' AND revenue = 12500;
UPDATE public.exec_x_revenue SET event_date = '2026-08-18' WHERE company = 'Vistage' AND revenue = 2000;
