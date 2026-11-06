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
import { getRoasDeals } from './metrics/roas-deals.js';
import { getRoasCounted } from './metrics/roas-counted.js';
import { getMarketingRoi } from './metrics/marketing-roi.js';
import { getMarketingOverview } from './metrics/marketing-overview.js';
import { getMarketingLeadsBySource } from './metrics/marketing-leads-by-source.js';
import { getMarketingPlatforms } from './metrics/marketing-platforms.js';
import { getContentMetrics } from './metrics/content-metrics.js';
import { getMarketingInsight } from './marketingInsight.js';
import { getMarketingChannelSummary } from './metrics/marketing-channel-summary.js';
import { getMarketingChannelResults } from './metrics/marketing-channel-results.js';
import { getAdPlatforms } from './metrics/ad-platforms.js';
import { ga4AgentRouter } from './ga4Agent.js';
import { roasAssistantRouter } from './roasAssistant.js';
import { roiAssistantRouter } from './roiAssistant.js';
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
// ROAS (Return on Ad Spend) table + charts — LIVE by Australian financial year, computed
// at request time from Supabase: FY22–24 from niki_ad_leads_tracking; FY25+ from
// google_ads_campaign_monthly + bing_ads_campaign_monthly + simple_digital_fees_monthly
// × (clover_audited_deals final_gads_tag=Yes ∪ ga4_ac_contact_source channel=cpc). See
// server/metrics/roas.js. Cached briefly per instance.
operations.get('/roas', async (_req, res) => {
  try {
    const payload = await cached('operations:roas', getRoas, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[operations:roas]', err);
    res.status(502).json({ error: 'Failed to load ROAS data from data source.', detail: err.message });
  }
});
// ROAS deals — the per-FY deal list behind the ROAS page's deals table (same FY sourcing
// as /roas). See server/metrics/roas-deals.js. Plain SELECT, cached briefly.
operations.get('/roas/deals', async (_req, res) => {
  try {
    const payload = await cached('operations:roas-deals', getRoasDeals, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[operations:roas-deals]', err);
    res.status(502).json({ error: 'Failed to load ROAS deals from data source.', detail: err.message });
  }
});
// ROAS-counted deals — the canonical deal-grained set behind the GA4 & Ads Leads page's
// "ROAS-counted only" view. Same source (public.roas_counted_deals) as the ROAS tab, so the
// two reconcile. See server/metrics/roas-counted.js. Plain SELECT, cached briefly.
operations.get('/contact-sources/roas-counted', async (_req, res) => {
  try {
    const payload = await cached('operations:roas-counted', getRoasCounted, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[operations:roas-counted]', err);
    res.status(502).json({ error: 'Failed to load ROAS-counted deals from data source.', detail: err.message });
  }
});
app.use('/api/operations', operations);

// Marketing sub-resources. The ROI page (whole-business revenue vs ad spend by Australian
// financial year) is computed live at request time from Supabase — revenue from
// invoice_tracking (Xero), ad spend from the google/bing/simple_digital monthly tables, and
// deals from activecampaign_deals. See server/metrics/marketing-roi.js. Cached briefly.
const marketing = express.Router();
marketing.use(requireAuth);
marketing.get('/roi', async (_req, res) => {
  try {
    const payload = await cached('marketing:roi', getMarketingRoi, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[marketing:roi]', err);
    res.status(502).json({ error: 'Failed to load marketing ROI from data source.', detail: err.message });
  }
});
// Channel Summary — monthly marketing spend stacked by Type/Platform, live from Xero
// (public.marketing_channel_monthly × marketing_channel_vendor_map). See
// server/metrics/marketing-channel-summary.js. Cached briefly.
marketing.get('/channel-summary', async (_req, res) => {
  try {
    const payload = await cached('marketing:channel-summary', getMarketingChannelSummary, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[marketing:channel-summary]', err);
    res.status(502).json({ error: 'Failed to load channel summary from data source.', detail: err.message });
  }
});
// Channel results — the two channel_list channels (Paid Google/Bing/Agency + Executive X)
// per FY for the "Spend & ROI" tab's Channel results table. Paid from the ROAS metric,
// Executive X from exec_x_revenue. See server/metrics/marketing-channel-results.js.
marketing.get('/channel-results', async (_req, res) => {
  try {
    const payload = await cached('marketing:channel-results', getMarketingChannelResults, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[marketing:channel-results]', err);
    res.status(502).json({ error: 'Failed to load channel results from data source.', detail: err.message });
  }
});
// Ad Platforms — raw per-platform performance (GA4 website events, Google Ads campaign
// monthly, Bing Ads campaign monthly), each a plain single-table SELECT the page toggles
// between client-side. See server/metrics/ad-platforms.js. Cached briefly.
marketing.get('/ad-platforms', async (_req, res) => {
  try {
    const payload = await cached('marketing:ad-platforms', getAdPlatforms, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[marketing:ad-platforms]', err);
    res.status(502).json({ error: 'Failed to load ad platform data from data source.', detail: err.message });
  }
});
// Overview — live KPI(s) for the Marketing Overview page. Currently the
// "Keynote enquiries" headline: per-FY count of deals created across the four
// deal groups (ads / organic / bureau / tailor), deduped by deal. See
// server/metrics/marketing-overview.js. Cached briefly.
marketing.get('/overview', async (_req, res) => {
  try {
    const payload = await cached('marketing:overview', getMarketingOverview, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[marketing:overview]', err);
    res.status(502).json({ error: 'Failed to load marketing overview from data source.', detail: err.message });
  }
});
// Leads & Bookings by source — enquiries + bookings split across five fixed lead sources
// (Google/Bing cpc, organic, Tailor, Bureau), per month + per FY, for the stacked chart and
// "By source" table on leads_bookings.html. See server/metrics/marketing-leads-by-source.js.
marketing.get('/leads-by-source', async (_req, res) => {
  try {
    const payload = await cached('marketing:leads-by-source', getMarketingLeadsBySource, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[marketing:leads-by-source]', err);
    res.status(502).json({ error: 'Failed to load leads by source from data source.', detail: err.message });
  }
});
// Platforms — latest weekly snapshot per social platform (followers / posts / engagement)
// + week-over-week follower change, for the "Platforms" table on content_social.html.
// Plain SELECT of public.social_platform_stats (filled weekly by apify-platforms-sync).
// See server/metrics/marketing-platforms.js. Cached briefly.
marketing.get('/platforms', async (_req, res) => {
  try {
    const payload = await cached('marketing:platforms', getMarketingPlatforms, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[marketing:platforms]', err);
    res.status(502).json({ error: 'Failed to load platform stats from data source.', detail: err.message });
  }
});
// Content metrics — login-gated figures (LinkedIn newsletter subscribers, article views)
// set manually or by a cookie-authenticated Apify sync. Plain SELECT of
// public.content_social_metrics. See server/metrics/content-metrics.js. Cached briefly.
marketing.get('/content-metrics', async (_req, res) => {
  try {
    const payload = await cached('marketing:content-metrics', getContentMetrics, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[marketing:content-metrics]', err);
    res.status(502).json({ error: 'Failed to load content metrics from data source.', detail: err.message });
  }
});
// Live AI Insight — a one-shot OpenAI insight over the live Overview + ROI figures for the
// selected FY (card on marketing.html). Read-only (context-stuffed, no DB tools). Cached per
// FY so repeated FY switches don't re-bill OpenAI. See server/marketingInsight.js. Needs
// OPENAI_API_KEY; returns a graceful {insight:null,note} (200) when the key isn't set.
marketing.get('/insight', async (req, res) => {
  let fy = String(req.query.fy || 'all').toLowerCase();
  if (fy !== 'all' && !/^fy\d{2}$/.test(fy)) fy = 'all';   // guard the cache key
  try {
    const payload = await cached('marketing:insight:' + fy, () => getMarketingInsight(fy), 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('[marketing:insight]', err);
    res.status(err.status || 502).json({ error: 'Failed to generate insight.', detail: err.message });
  }
});
app.use('/api/marketing', marketing);

// MAG GA4 Agent — on-demand GA4 reports via the GA4 On-Demand Report Claude routine.
app.use('/api/ga4-agent', ga4AgentRouter);

// ROAS tab read-only chat assistant (context-stuffed OpenAI call; no DB tools). See
// server/roasAssistant.js. Needs OPENAI_API_KEY.
app.use('/api/roas-assistant', roasAssistantRouter);

// ROI tab read-only chat assistant (context-stuffed OpenAI call; no DB tools). See
// server/roiAssistant.js. Needs OPENAI_API_KEY (same key as the ROAS assistant).
app.use('/api/roi-assistant', roiAssistantRouter);

// Serve the plain HTML/CSS/JS pages from public/.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Root -> the dashboard homepage (which bounces to login if not signed in).
app.get('/', (_req, res) => res.redirect('/home.html'));

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
