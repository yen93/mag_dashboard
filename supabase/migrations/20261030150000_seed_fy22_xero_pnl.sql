-- Seed FY22 (year ended 30 Jun 2022) Xero P&L into the ROI tab, same as the FY23 seed
-- (migration 20261030140000). Source: manual Xero UI P&L export (accrual), entity "Ditch
-- Investments Pty Ltd" (MAG's legal trading entity), file "…Profit and Loss FY22.xlsx".
-- Xero's P&L API can't reach FY22 (only current + 3 prior FYs), hence the manual seed. Grouping
-- validated against the FY24 export, which reconciles to the cent with the API-sourced FY24 rows.
--
--   total_income       = Xero "Total Trading Income" (ex-GST, accrual; EXCLUDES Other Income —
--                        FY22's Other Income is a $38,303 NSW COVID relief grant, left out to
--                        match the FY24+ methodology)
--   cost_of_sales      = Xero "Total Cost of Sales"
--   operating_expenses = Xero "Total Operating Expenses" (incl. the $103k motor-vehicle immediate
--                        deduction booked that year)
--   owner_wages        = "Wages - James & Mia" + "Super - James & Mia"
--   total_spend        = GENERATED (op-ex + cost of sales) — not inserted
--
-- Annual-only (export has year columns, not monthly), stored as ONE row dated 2022-06-01: BY_FY
-- groups it into FY22; it's below the by-month chart floor (2023-07-01) so no lumpy single bar.

insert into public.xero_expenses_monthly (month, operating_expenses, cost_of_sales, total_income, owner_wages)
values ('2022-06-01', 381152.61, 29828.40, 427600.39, 126500.00)
on conflict (month) do update set
  operating_expenses = excluded.operating_expenses,
  cost_of_sales      = excluded.cost_of_sales,
  total_income       = excluded.total_income,
  owner_wages        = excluded.owner_wages,
  synced_at          = now();

-- Top-12 FY22 P&L spend accounts for the "Where the spend goes" chart.
delete from public.xero_pnl_accounts_fy where fy_end = 2022;
insert into public.xero_pnl_accounts_fy (fy_end, account_name, kind, amount) values
  (2022, 'Wages - James & Mia',                  'expense',       115000.00),
  (2022, 'Motor vehicle - Immediate deduction',  'expense',       103083.66),
  (2022, 'WrkPod Staff',                         'expense',        25522.38),
  (2022, 'Advertising and marketing',            'expense',        18903.23),
  (2022, 'Setup costs of BASE CAMP & SHED',      'expense',        13020.89),
  (2022, 'Assets < $20,000',                     'expense',        12011.25),
  (2022, 'Super - James & Mia',                  'expense',        11500.00),
  (2022, 'Rent/ Pindari Lease',                  'expense',         8800.00),
  (2022, 'MAG Casual Staff',                     'expense',         8485.00),
  (2022, 'Computer expenses',                    'expense',         8428.59),
  (2022, 'MAG program delivery expenses',        'cost_of_sales',   8246.68),
  (2022, 'Purchases - Book',                     'cost_of_sales',   7725.82);
