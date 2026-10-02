import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter, requireAuth } from './auth.js';
import { getSales } from './metrics/sales.js';
import { getMarketing } from './metrics/marketing.js';
import { getOperations } from './metrics/operations.js';
import { getLivDeals } from './metrics/liv-deals.js';
import { getSalesTopline } from './metrics/sales-topline.js';
import { getMagBuyerSheet } from './metrics/mag-buyer-sheet.js';
import { getInvoiceTracking } from './metrics/invoice-tracking.js';
import { ga4AgentRouter } from './ga4Agent.js';
import { cached } from './lib/cache.js';
import { normalizeRange } from './lib/range.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Health check (useful for Cloud Run / uptime checks).
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Auth routes: /api/request-code, /api/verify-code, /api/me
app.use('/api', authRouter);

// Protected metrics routes. Each area is composed from live data providers,
// cached briefly per (area,range) so repeated loads don't re-hit the APIs.
const composers = { sales: getSales, marketing: getMarketing, operations: getOperations };
const metrics = express.Router();
metrics.use(requireAuth);
metrics.get('/:area', async (req, res) => {
  const composer = composers[req.params.area];
  if (!composer) return res.status(404).json({ error: 'Unknown metrics area.' });
  const range = normalizeRange(req.query.range);
  try {
    const payload = await cached(`${req.params.area}:${range}`, () => composer(range));
    res.json(payload);
  } catch (err) {
    console.error(`[metrics:${req.params.area}]`, err);
    res.status(502).json({ error: 'Failed to load metrics from data source.', detail: err.message });
  }
});
app.use('/api/metrics', metrics);

// Sales sub-resources. The LIV pipeline deals table reads a pre-computed
// Supabase cache (public.sales_liv_deals), refreshed Mon–Fri by the
// sales-deals-sync edge function. It's a plain SELECT (no AC calls at request
// time), so a short cache is plenty. The response is always the 2026 window —
// range is ignored.
const sales = express.Router();
sales.use(requireAuth);
sales.get('/deals', async (_req, res) => {
  try {
    const payload = await cached('sales:deals', getLivDeals, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[sales:deals]', err);
    res.status(502).json({ error: 'Failed to load deals from data source.', detail: err.message });
  }
});
// Sales page Top-Line KPIs — a pre-computed Supabase cache (public.sales_topline),
// refreshed weekly (Mon 6am PH) by the sales-topline-sync Claude routine. Plain
// SELECT, so a short cache is plenty.
sales.get('/topline', async (_req, res) => {
  try {
    const payload = await cached('sales:topline', getSalesTopline, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[sales:topline]', err);
    res.status(502).json({ error: 'Failed to load sales metrics from data source.', detail: err.message });
  }
});
app.use('/api/sales', sales);

// Operations sub-resources. The Buyer Sheet table reads a pre-computed Supabase
// cache (public.mag_buyer_sheet), refreshed Mon–Fri by the buyer-sheet-sync edge
// function. It's a plain SELECT, so a short cache is plenty.
const operations = express.Router();
operations.use(requireAuth);
operations.get('/buyer-sheet', async (_req, res) => {
  try {
    const payload = await cached('operations:buyer-sheet', getMagBuyerSheet, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[operations:buyer-sheet]', err);
    res.status(502).json({ error: 'Failed to load buyer sheet from data source.', detail: err.message });
  }
});
// Invoice Tracking table reads a pre-computed Supabase cache
// (public.invoice_tracking), refreshed Mon–Fri by the invoice-tracking-sync edge
// function from Xero (read-only). Plain SELECT, so a short cache is plenty.
operations.get('/invoice-tracking', async (_req, res) => {
  try {
    const payload = await cached('operations:invoice-tracking', getInvoiceTracking, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[operations:invoice-tracking]', err);
    res.status(502).json({ error: 'Failed to load invoices from data source.', detail: err.message });
  }
});
app.use('/api/operations', operations);

// MAG GA4 Agent — on-demand GA4 reports via the GA4 On-Demand Report Claude routine.
app.use('/api/ga4-agent', ga4AgentRouter);

// Serve the plain HTML/CSS/JS pages from public/.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Root -> the first dashboard page (which bounces to login if not signed in).
app.get('/', (_req, res) => res.redirect('/sales_overview.html'));

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
