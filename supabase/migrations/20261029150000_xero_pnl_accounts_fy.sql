-- Per-financial-year Xero P&L spend accounts (expense + cost_of_sales), for the
-- ROI tab "Where the spend goes" chart. STATIC seed from the Xero P&L via MCP
-- (top ~12 accounts per FY; the long tail folds into an "Other" bar computed at
-- render time against xero_expenses_monthly total_spend). END-year FY. FY27 is
-- partial (YTD). Refresh routine pending.

CREATE TABLE IF NOT EXISTS public.xero_pnl_accounts_fy (
  fy_end       integer     NOT NULL,          -- AU FY end year (END-year): 2025 = FY25
  account_name text        NOT NULL,          -- Xero GL account name (verbatim)
  kind         text        NOT NULL           -- 'expense' | 'cost_of_sales'
                 CHECK (kind IN ('expense','cost_of_sales')),
  amount       numeric     NOT NULL,          -- AUD, ex-GST, accrual, annual total for the FY
  synced_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fy_end, account_name)
);

COMMENT ON TABLE public.xero_pnl_accounts_fy IS
  'Per-financial-year Xero P&L spend accounts (expense + cost_of_sales), for the ROI tab "Where the spend goes" chart. STATIC seed from the Xero P&L via MCP (top ~12 accounts per FY; the long tail folds into an "Other" bar computed at render time against xero_expenses_monthly total_spend). END-year FY. FY27 is partial (YTD). Refresh routine pending.';

-- SEED (top ~12 spend accounts per FY; amounts are real Xero P&L figures)
-- FY24 = Jul 2023–Jun 2024.  (FY24 total spend reconciles to ~$812,208.)
INSERT INTO public.xero_pnl_accounts_fy (fy_end, account_name, kind, amount) VALUES
(2024,'MAG program delivery expenses','cost_of_sales',143151.91),
(2024,'Wages - James & Mia','expense',123402.00),
(2024,'Setup costs of BASE CAMP & SHED','expense',81844.23),
(2024,'MAG Casual Staff','expense',80726.44),
(2024,'WrkPod Staff','expense',69935.73),
(2024,'Advertising and marketing','expense',60069.44),
(2024,'WRKPOD mthly desk fee','expense',31851.70),
(2024,'Super - James & Mia','expense',26400.00),
(2024,'Staff training','expense',25209.38),
(2024,'Motor vehicle expenses','expense',21175.53),
(2024,'Travel and accommodation','cost_of_sales',18834.27),
(2024,'Fuel and oil','cost_of_sales',14712.99),
-- FY25 = Jul 2024–Jun 2025.  (FY25 total spend reconciles to ~$966,995.)
(2025,'Wages - James & Mia','expense',270000.00),
(2025,'MAG program delivery expenses','cost_of_sales',127414.89),
(2025,'MAG Casual Staff','expense',91218.68),
(2025,'Advertising and marketing','expense',83504.38),
(2025,'WrkPod Staff','expense',81454.29),
(2025,'WRKPOD mthly desk fee','expense',39874.65),
(2025,'Rent/ Pindari Lease','expense',33628.72),
(2025,'Super - James & Mia','expense',31050.00),
(2025,'Insurance - General','expense',27190.13),
(2025,'Setup costs of BASE CAMP & SHED','expense',24445.26),
(2025,'Travel and accommodation','cost_of_sales',22484.02),
(2025,'Motor vehicle expenses','expense',19377.90),
-- FY26 = Jul 2025–Jun 2026.  (FY26 total spend reconciles to ~$1,200,286.)
(2026,'Wages - James & Mia','expense',360000.00),
(2026,'MAG program delivery expenses','cost_of_sales',193902.74),
(2026,'WrkPod Staff','expense',130017.21),
(2026,'MAG Casual Staff','expense',109504.02),
(2026,'Advertising and marketing','expense',94055.76),
(2026,'Super - James & Mia','expense',43200.00),
(2026,'Travel and accommodation','cost_of_sales',36562.88),
(2026,'General small business Expenses','expense',29990.70),
(2026,'Setup costs of BASE CAMP & SHED','expense',29946.37),
(2026,'Replacement assets (low cost)','expense',27441.87),
(2026,'Staff training','expense',18291.40),
(2026,'Insurance - General','expense',17224.51),
-- FY27 = Jul 2026–Jun 2027, PARTIAL (through ~29 Oct 2026). total spend ~$227,756.
(2027,'Wages - James & Mia','expense',67586.00),
(2027,'WrkPod Staff','expense',50406.09),
(2027,'Advertising and marketing','expense',22191.15),
(2027,'MAG program delivery expenses','cost_of_sales',11586.43),
(2027,'Setup costs of BASE CAMP & SHED','expense',9694.93),
(2027,'Insurance - General','expense',9089.90),
(2027,'Superannuation','expense',7351.50),
(2027,'General small business Expenses','expense',7135.55),
(2027,'MAG Casual Staff','expense',5762.50),
(2027,'Software subscriptions','expense',4909.69),
(2027,'Purchases - Book','cost_of_sales',4772.73),
(2027,'Replacement assets (low cost)','expense',4602.60)
ON CONFLICT (fy_end, account_name) DO UPDATE
  SET kind = EXCLUDED.kind,
      amount = EXCLUDED.amount,
      synced_at = now();
