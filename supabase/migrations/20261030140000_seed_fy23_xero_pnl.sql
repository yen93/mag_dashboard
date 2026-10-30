-- Seed FY23 (year ended 30 Jun 2023) Xero P&L into the ROI tab's data, so the FY23
-- tiles (revenue / spend / Return on spend / Net ROI / CAC / avg rev per client) populate.
--
-- WHY A MANUAL SEED: Xero's P&L *report* API only exposes the current + 3 prior financial
-- years, so xero_expenses_monthly (API-sourced) starts at FY24 (Jul 2023). FY22/FY23 can't be
-- pulled from the API at all. These figures come from a manual Xero UI export of the P&L
-- (Accounting > Reports > Profit and Loss, accrual basis) for the entity "Ditch Investments
-- Pty Ltd" (MAG's legal trading entity), file "…Profit and Loss FY23.xlsx". The grouping below
-- was validated against the FY24 export, whose Trading-Income / Cost-of-Sales / Operating-
-- Expenses totals reconcile TO THE CENT with the API-seeded FY24 rows already in the table.
--
-- Mapping (same rules as the FY24+ API rows):
--   total_income       = Xero "Total Trading Income" (ex-GST, accrual; EXCLUDES Other Income
--                        like interest, matching how the FY24+ rows were built)
--   cost_of_sales      = Xero "Total Cost of Sales"
--   operating_expenses = Xero "Total Operating Expenses"
--   owner_wages        = "Wages - James & Mia" + "Super - James & Mia" (subset of op-ex)
--   total_spend        = GENERATED (operating_expenses + cost_of_sales) — not inserted
--
-- Only an ANNUAL total is available from this export (one column per FY, not monthly), so FY23
-- is stored as ONE row dated 2023-06-01. BY_FY (marketing-roi.js) groups by FY, so this lands
-- in FY23 correctly; it sits below the month-chart floor (2023-07-01) so it does NOT appear as a
-- single lumpy bar in the by-month chart. (FY22 is still absent — its export came back as FY24.)

insert into public.xero_expenses_monthly (month, operating_expenses, cost_of_sales, total_income, owner_wages)
values ('2023-06-01', 791788.12, 290969.83, 1074456.87, 265200.00)
on conflict (month) do update set
  operating_expenses = excluded.operating_expenses,
  cost_of_sales      = excluded.cost_of_sales,
  total_income       = excluded.total_income,
  owner_wages        = excluded.owner_wages,
  synced_at          = now();

-- Top-12 FY23 P&L spend accounts for the ROI tab "Where the spend goes" chart
-- (same shape as the FY24+ rows: raw Xero account name; kind = cost_of_sales | expense).
delete from public.xero_pnl_accounts_fy where fy_end = 2023;
insert into public.xero_pnl_accounts_fy (fy_end, account_name, kind, amount) values
  (2023, 'MAG program delivery expenses',        'cost_of_sales', 249236.11),
  (2023, 'Wages - James & Mia',                  'expense',       240000.00),
  (2023, 'Setup costs of BASE CAMP & SHED',      'expense',       107403.79),
  (2023, 'MAG Casual Staff',                     'expense',       107095.54),
  (2023, 'WrkPod Staff',                         'expense',        59031.78),
  (2023, 'Advertising and marketing',            'expense',        47211.59),
  (2023, 'Dividends Paid - James Castrission',   'expense',        44277.88),
  (2023, 'Super - James & Mia',                  'expense',        25200.00),
  (2023, 'Assets < $20,000',                     'expense',        20334.01),
  (2023, 'Travel and accommodation',             'cost_of_sales',  17231.15),
  (2023, 'WRKPOD mthly desk fee',                'expense',        15794.75),
  (2023, 'Motor vehicle - Immediate deduction',  'expense',        14189.00);
