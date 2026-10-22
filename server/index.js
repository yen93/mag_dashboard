import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter, requireAuth } from './auth.js';
import { getSales } from './metrics/sales.js';
import { getMarketing } from './metrics/marketing.js';
import { getOperations } from './metrics/operations.js';
import { getLivDeals } from './metrics/liv-deals.js';
import { getSalesTopline } from './metrics/sales-topline.js';
import { getToplineCards, cleanDate } from './metrics/sales-topline-cards.js';
import { getAcDealsTable } from './metrics/ac-deals-table.js';
import { getMagBuyerSheet } from './metrics/mag-buyer-sheet.js';
import { getInvoiceTracking } from './metrics/invoice-tracking.js';
import { getAcContactSources } from './metrics/ac-contact-sources.js';
import { getNewPaidLeads } from './metrics/new-paid-leads.js';
import { getAcAdLeads } from './metrics/ac-ad-leads.js';
import { getPaidGoogleEnquiries } from './metrics/paid-google-enquiries.js';
import { getRoas } from './metrics/roas.js';
import { ga4AgentRouter } from './ga4Agent.js';
import { cached, clearCache } from './lib/cache.js';
import { normalizeRange } from './lib/range.js';
import { canReviewJc } from './users.js';
import { q } from './providers/supabase.js';

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
// Sales page Top-Line Header cards — aggregates public.ac_deals_ytd for the
// selected date range (?from=YYYY-MM-DD&to=YYYY-MM-DD, both optional, filter on
// deal created date). Cached per range.
sales.get('/topline-cards', async (req, res) => {
  try {
    const from = cleanDate(req.query.from);
    const to = cleanDate(req.query.to);
    const payload = await cached(`sales:topline-cards:${from || ''}:${to || ''}`,
      () => getToplineCards({ from, to }), 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[sales:topline-cards]', err);
    res.status(502).json({ error: 'Failed to load top-line cards from data source.', detail: err.message });
  }
});
// AC Deals table reads public.ac_deals_ytd (all deals from July 1, 2024 to present).
// Plain SELECT, cached briefly.
sales.get('/ac-deals', async (_req, res) => {
  try {
    const payload = await cached('sales:ac-deals', getAcDealsTable, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[sales:ac-deals]', err);
    res.status(502).json({ error: 'Failed to load AC deals from data source.', detail: err.message });
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
// AC Contact Sources table reads a pre-computed Supabase cache
// (public.ga4_ac_contact_source), populated by scripts/map_ga4_ac.py in the
// google_ads_leads_tracking repo. Plain SELECT, so a short cache is plenty.
operations.get('/contact-sources', async (_req, res) => {
  try {
    const payload = await cached('operations:contact-sources', getAcContactSources, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[operations:contact-sources]', err);
    res.status(502).json({ error: 'Failed to load contact sources from data source.', detail: err.message });
  }
});
// Set the JC manual review tag on a contact-sources row. Restricted to James + admins
// (canReviewJc). Durable manual override in public.ga4cs_jc_manual_review (upsert) plus
// an append-only audit row in ...._log. decision '' / null = reviewed, not paid/SEO.
const ALLOWED_JC_TAGS = ['Could be SEO or Paid Ad'];
operations.post('/contact-sources/jc-tag', async (req, res) => {
  if (!canReviewJc(req.user && req.user.email)) {
    return res.status(403).json({ error: 'Not authorised to set the JC review tag.' });
  }
  const contactId = String((req.body && req.body.contactId) || '').trim();
  if (!contactId) {
    return res.status(400).json({ error: 'contactId is required.' });
  }
  const setBy = req.user.email;

  // Reset: selecting "— set tag —" on an already-reviewed row removes the override,
  // so the contact goes back to "for review". Logged as an action='reset' audit row.
  if (req.body && req.body.reset === true) {
    try {
      await q(`delete from public.ga4cs_jc_manual_review where contact_id = $1`, [contactId]);
      await q(
        `insert into public.ga4cs_jc_manual_review_log (contact_id, decision, set_by, action)
         values ($1, null, $2, 'reset')`,
        [contactId, setBy]
      );
      clearCache();
      return res.json({ contactId, jcManualTag: null, jcReviewed: false, jcSetBy: null, jcSetAt: null });
    } catch (err) {
      console.error('[operations:contact-sources:jc-tag reset]', err);
      return res.status(502).json({ error: 'Failed to reset the JC review tag.', detail: err.message });
    }
  }

  let decision = req.body && req.body.decision;
  decision = decision == null ? null : String(decision).trim();
  if (decision === '') decision = null;
  if (decision !== null && !ALLOWED_JC_TAGS.includes(decision)) {
    return res.status(400).json({ error: 'Invalid decision value.' });
  }
  try {
    await q(
      `insert into public.ga4cs_jc_manual_review (contact_id, decision, set_by, updated_at)
       values ($1, $2, $3, now())
       on conflict (contact_id) do update
         set decision = excluded.decision, set_by = excluded.set_by, updated_at = now()`,
      [contactId, decision, setBy]
    );
    await q(
      `insert into public.ga4cs_jc_manual_review_log (contact_id, decision, set_by)
       values ($1, $2, $3)`,
      [contactId, decision, setBy]
    );
    // Drop the cached contact-sources payload so the next load reflects the change.
    clearCache();
    res.json({
      contactId,
      jcManualTag: decision,
      jcReviewed: true,
      jcSetBy: setBy,
      jcSetAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[operations:contact-sources:jc-tag]', err);
    res.status(502).json({ error: 'Failed to save the JC review tag.', detail: err.message });
  }
});
// New Paid Leads table reads a pre-computed Supabase cache (public.ac_new_leads),
// filled Mon–Fri by the new-paid-leads-sync edge function from ActiveCampaign's
// "Src - *" acquisition fields. Plain SELECT, so a short cache is plenty.
operations.get('/new-paid-leads', async (_req, res) => {
  try {
    const payload = await cached('operations:new-paid-leads', getNewPaidLeads, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[operations:new-paid-leads]', err);
    res.status(502).json({ error: 'Failed to load new paid leads from data source.', detail: err.message });
  }
});
// AC Ad Leads Tagging table reads a pre-computed Supabase cache
// (public.ac_ad_leads_tagging), filled Mon–Fri by the ac-ad-leads-sync edge
// function (AC tag 88 contacts + their deals). Plain SELECT, so a short cache is plenty.
operations.get('/ac-ad-leads', async (_req, res) => {
  try {
    const payload = await cached('operations:ac-ad-leads', getAcAdLeads, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[operations:ac-ad-leads]', err);
    res.status(502).json({ error: 'Failed to load AC ad leads from data source.', detail: err.message });
  }
});
// Historical Paid Leads table reads a pre-computed Supabase cache
// (public.mag_paid_google_enquiries): the 39 reconciled "Paid – Google" enquiries,
// anchored to a fixed set of AC deal_ids and refreshed daily from the AC mirror by
// the paid-google-enquiries-sync edge function. Plain SELECT, so a short cache is plenty.
operations.get('/paid-google-enquiries', async (_req, res) => {
  try {
    const payload = await cached('operations:paid-google-enquiries', getPaidGoogleEnquiries, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[operations:paid-google-enquiries]', err);
    res.status(502).json({ error: 'Failed to load paid Google enquiries from data source.', detail: err.message });
  }
});
// ROAS (Return on Ad Spend) table + charts read a pre-computed Supabase cache
// (public.roas_year_on_year): one row per calendar year, mirrored from the
// "Year on Year" tab of the MAG Marketing ROAS Report Google Sheet by the
// roas-year-on-year-sync Claude routine. Plain SELECT, so a short cache is plenty.
operations.get('/roas', async (_req, res) => {
  try {
    const payload = await cached('operations:roas', getRoas, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[operations:roas]', err);
    res.status(502).json({ error: 'Failed to load ROAS data from data source.', detail: err.message });
  }
});
app.use('/api/operations', operations);

// MAG GA4 Agent — on-demand GA4 reports via the GA4 On-Demand Report Claude routine.
app.use('/api/ga4-agent', ga4AgentRouter);

// Serve the plain HTML/CSS/JS pages from public/.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Root -> the dashboard homepage (which bounces to login if not signed in).
app.get('/', (_req, res) => res.redirect('/home.html'));

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
