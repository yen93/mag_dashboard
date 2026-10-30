-- Replace the FY22 & FY23 ANNUAL single-row seeds (migrations 20261030140000 /
-- 20261030150000) with full MONTHLY rows, so the ROI tab's revenue-vs-spend-by-month
-- chart renders for those years too. Source: manual Xero-UI P&L exports with monthly
-- columns ("…Current_financial_year_by_month fy22/fy23.xlsx", entity "Ditch Investments
-- Pty Ltd", accrual). Each month's monthly sums reconcile TO THE CENT with the annual
-- seeds already applied (income / cost_of_sales / operating_expenses / owner_wages).
--
-- Upserting all 24 months overwrites the two prior annual lump rows (2022-06-01 /
-- 2023-06-01 held the whole-FY totals; they now hold June-only values). total_spend is a
-- GENERATED column (op-ex + cost of sales) — not inserted. owner_wages (Wages+Super –
-- James & Mia) is booked by Xero as a single June journal each year, so it lands entirely
-- in June — correct at the FY level, but note the by-month chart's June spend bar can go
-- NEGATIVE when "exclude owner wages" is on (June's owner comp exceeds its other spend).
-- A few months also carry year-end accrual reversals (e.g. Jun-2023 income is negative) —
-- kept as-is; FY totals net correctly. Requires the marketing-roi.js MONTH_FLOOR lowered
-- to 2021-07-01 (same commit) + a Cloud Run redeploy for the chart to show these months.

insert into public.xero_expenses_monthly (month, operating_expenses, cost_of_sales, total_income, owner_wages) values
  ('2021-07-01',  3378.14,  3028.66,  11375.00,      0.00),
  ('2021-08-01', 22804.65,   351.24,  21534.13,      0.00),
  ('2021-09-01', 32082.88,   464.78,  55627.10,      0.00),
  ('2021-10-01', 28424.20,  7392.27,      0.00,      0.00),
  ('2021-11-01', 34122.58,  1425.63,  18520.00,      0.00),
  ('2021-12-01', 19389.11,  3060.81,  41615.23,      0.00),
  ('2022-01-01', 15138.37,  1503.50,      0.00,      0.00),
  ('2022-02-01', 25968.23,  1632.58,  32319.09,      0.00),
  ('2022-03-01', 32317.27,  3525.94,  75162.92,      0.00),
  ('2022-04-01', 30967.56,  5488.23,  37763.39,      0.00),
  ('2022-05-01', 42779.12,  -500.36,  42756.89,      0.00),
  ('2022-06-01', 93780.50,  2455.12,  90926.64, 126500.00),
  ('2022-07-01', 38879.71,  8962.94, 150032.04,      0.00),
  ('2022-08-01', 36480.60, 13466.76, 118109.25,      0.00),
  ('2022-09-01', 44328.96, 16655.31,  58729.23,      0.00),
  ('2022-10-01', 46724.14, 20082.02, 173384.92,      0.00),
  ('2022-11-01', 95456.03, 69629.33,  80826.05,      0.00),
  ('2022-12-01', 66512.79, 33041.89,  22902.81,      0.00),
  ('2023-01-01', 47969.39, 11524.50,  79818.58,      0.00),
  ('2023-02-01', 37216.69, 16878.35, 197959.21,      0.00),
  ('2023-03-01', 98758.39, 33806.87,  82544.81,      0.00),
  ('2023-04-01', 92003.15, 32343.75,  20224.72,      0.00),
  ('2023-05-01', 65307.49,  6846.36, 101836.26,      0.00),
  ('2023-06-01',122150.78, 27731.75, -11911.01, 265200.00)
on conflict (month) do update set
  operating_expenses = excluded.operating_expenses,
  cost_of_sales      = excluded.cost_of_sales,
  total_income       = excluded.total_income,
  owner_wages        = excluded.owner_wages,
  synced_at          = now();
