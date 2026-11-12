// server/metrics/db-automations.js
// Provides live telemetry, execution history, and catalog of all active Supabase Edge Functions,
// pg_cron scheduled jobs, webhook receivers, and on-demand database sync routines.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { config } from '../config.js';

// Canonical catalog of all active database automations and edge functions.
// Each entry contains its authoritative description, trigger type, schedule, and metadata.
export const AUTOMATIONS_CATALOG = [
  // --- ActiveCampaign & Sales Deals ---
  {
    id: 'activecampaign-deals-sync',
    name: 'ActiveCampaign Deals Sync',
    slug: 'activecampaign-deals-sync',
    type: 'edge_function',
    category: 'Sales',
    description: 'Performs a full automated sync of all ActiveCampaign deals (Won, Open, Lost) across pipelines via AC REST API, updating public.activecampaign_deals in place without table downtime.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Mon–Fri 5:00 AM PH (21:00 UTC)',
    cronName: 'activecampaign-deals-sync-daily',
    cronExpression: '0 21 * * 0-4',
    targetTables: ['public.activecampaign_deals'],
    sourceFile: 'supabase/functions/activecampaign-deals-sync/index.ts'
  },
  {
    id: 'activecampaign-contacts-sync',
    name: 'ActiveCampaign Contacts Sync',
    slug: 'activecampaign-contacts-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Full automated pagination sync of all ActiveCampaign contacts (15,000+ records) and custom qualification fields into public.activecampaign_contacts.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Mon–Fri 5:30 AM PH (21:30 UTC)',
    cronName: 'activecampaign-contacts-sync-daily',
    cronExpression: '30 21 * * 0-4',
    targetTables: ['public.activecampaign_contacts'],
    sourceFile: 'supabase/functions/activecampaign-contacts-sync/index.ts'
  },
  {
    id: 'ac-indirect-deals-sync',
    name: 'AC Indirect Deals Sync',
    slug: 'ac-indirect-deals-sync',
    type: 'edge_function',
    category: 'Sales',
    description: 'Rebuilds public.ac_indirect_deals with every indirect (bureau, PCO, event-manager) deal from ActiveCampaign (2021 to present), powering the Indirect Deals & Partners views.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Mon–Fri 6:15 AM PH (22:15 UTC)',
    cronName: 'ac-indirect-deals-sync-daily',
    cronExpression: '15 22 * * 0-4',
    targetTables: ['public.ac_indirect_deals'],
    sourceFile: 'supabase/functions/ac-indirect-deals-sync/index.ts'
  },
  {
    id: 'sales-deals-sync',
    name: 'Sales Deals Sync (LIV Pipeline)',
    slug: 'sales-deals-sync',
    type: 'edge_function',
    category: 'Sales',
    description: 'Materializes won speaking enquiries and LIV conference pipeline deals into public.sales_liv_deals for the main Sales overview dashboard.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Mon–Fri 6:00 AM PH (22:00 UTC)',
    cronName: 'sales-deals-sync-daily',
    cronExpression: '0 22 * * 0-4',
    targetTables: ['public.sales_liv_deals'],
    sourceFile: 'supabase/functions/sales-deals-sync/index.ts'
  },
  {
    id: 'buyer-sheet-sync',
    name: 'Buyer Sheet Sync',
    slug: 'buyer-sheet-sync',
    type: 'edge_function',
    category: 'Operations',
    description: 'Materializes the MAG Buyer Analysis sheet (2026/2027) into public.mag_buyer_sheet, combining ActiveCampaign deals with web search company domain enrichment.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Mon–Fri 6:00 AM PH (22:00 UTC)',
    cronName: 'buyer-sheet-sync-daily',
    cronExpression: '0 22 * * 0-4',
    targetTables: ['public.mag_buyer_sheet'],
    sourceFile: 'supabase/functions/buyer-sheet-sync/index.ts'
  },

  // --- Marketing Leads & Enquiries ---
  {
    id: 'new-paid-leads-sync',
    name: 'New Paid Leads Sync',
    slug: 'new-paid-leads-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Fills public.ac_new_leads with incoming paid acquisition contacts from ActiveCampaign custom fields (Src - Acquisition Channel, UTM parameters) for leads tracking.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Mon–Fri 6:00 AM PH (22:00 UTC)',
    cronName: 'new-paid-leads-sync-daily',
    cronExpression: '0 22 * * 0-4',
    targetTables: ['public.ac_new_leads'],
    sourceFile: 'supabase/functions/new-paid-leads-sync/index.ts'
  },
  {
    id: 'ac-ad-leads-sync',
    name: 'AC Ad Leads Tagging Sync',
    slug: 'ac-ad-leads-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Fills public.ac_ad_leads_tagging by scanning contacts tagged with AC tag 88 (Ad Leads) and joining deal qualification values.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Weekly · Mon 6:30 AM PH (Sun 22:30 UTC)',
    cronName: 'ac-ad-leads-sync-weekly',
    cronExpression: '30 22 * * 0',
    targetTables: ['public.ac_ad_leads_tagging'],
    sourceFile: 'supabase/functions/ac-ad-leads-sync/index.ts'
  },
  {
    id: 'contact-sources-sync',
    name: 'Contact Sources Pipeline Orchestrator',
    slug: 'contact-sources-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Single orchestrator pipeline that runs contact attribution, maps GA4 web conversions with AC leads, and denormalizes financial year and Xero fee columns into ga4_ac_contact_source_denormalized.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Daily 6:00 AM PH (22:00 UTC)',
    cronName: 'contact-sources-sync-daily',
    cronExpression: '0 22 * * *',
    targetTables: ['public.ga4_ac_contact_source_denormalized'],
    sourceFile: 'supabase/functions/contact-sources-sync/index.ts'
  },
  {
    id: 'paid-google-enquiries-sync',
    name: 'Paid Google Enquiries Sync',
    slug: 'paid-google-enquiries-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Maintains the Historical Paid Leads cache in public.mag_paid_google_enquiries anchored to the 39 canonical Paid-Google enquiries.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Daily 6:30 AM PH (22:30 UTC)',
    cronName: 'paid-google-enquiries-sync-daily',
    cronExpression: '30 22 * * *',
    targetTables: ['public.mag_paid_google_enquiries'],
    sourceFile: 'supabase/functions/paid-google-enquiries-sync/index.ts'
  },
  {
    id: 'calendly-source-sync',
    name: 'Calendly Source Sync',
    slug: 'calendly-source-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Pulls recent Calendly bookings, matches invitee emails against AC contacts, and writes source channel attribution tags.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Daily 6:00 AM PH (22:00 UTC)',
    cronName: 'calendly-source-sync-daily',
    cronExpression: '0 22 * * *',
    targetTables: ['public.calendly_bookings'],
    sourceFile: 'supabase/functions/calendly-source-sync/index.ts'
  },

  // --- Advertising & Web Analytics ---
  {
    id: 'google-ads-campaign-monthly-sync',
    name: 'Google Ads Monthly Spend Sync',
    slug: 'google-ads-campaign-monthly-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Queries Google Ads API via service account credentials to extract monthly campaign costs and upserts them into public.google_ads_campaign_monthly_raw for ROAS calculation.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Weekly · Mon 6:00 AM PH (Sun 22:00 UTC)',
    cronName: 'google-ads-campaign-monthly-sync-weekly',
    cronExpression: '0 22 * * 0',
    targetTables: ['public.google_ads_campaign_monthly_raw'],
    sourceFile: 'supabase/functions/google-ads-campaign-monthly-sync/index.ts'
  },
  {
    id: 'bing-ads-campaign-monthly-sync',
    name: 'Bing Ads Monthly Spend Sync',
    slug: 'bing-ads-campaign-monthly-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Refreshes public.bing_ads_campaign_monthly_raw with monthly Microsoft Advertising costs for the multi-channel ROAS ad-spend denominator.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Daily 6:00 AM PH (22:00 UTC)',
    cronName: 'bing-ads-campaign-monthly-sync-daily',
    cronExpression: '0 22 * * *',
    targetTables: ['public.bing_ads_campaign_monthly_raw'],
    sourceFile: 'supabase/functions/bing-ads-campaign-monthly-sync/index.ts'
  },
  {
    id: 'ga4-website-traffic-sync',
    name: 'GA4 Website Traffic Sync',
    slug: 'ga4-website-traffic-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Pulls monthly website sessions and AI referral visits from GA4 Data API (property 363754280) and upserts snapshots into public.ga4_website_traffic_snapshots.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Weekly · Mon 4:15 AM PH (Sun 20:15 UTC)',
    cronName: 'ga4-website-traffic-sync-weekly',
    cronExpression: '15 20 * * 0',
    targetTables: ['public.ga4_website_traffic_snapshots'],
    sourceFile: 'supabase/functions/ga4-website-traffic-sync/index.ts'
  },
  {
    id: 'ga4-click-to-call-sync',
    name: 'GA4 Click-to-Call Sync',
    slug: 'ga4-click-to-call-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Extracts monthly phone-click (click_to_call) conversions by acquisition channel from GA4 into public.ga4_click_to_call_monthly.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Weekly · Mon 4:20 AM PH (Sun 20:20 UTC)',
    cronName: 'ga4-click-to-call-sync-weekly',
    cronExpression: '20 20 * * 0',
    targetTables: ['public.ga4_click_to_call_monthly'],
    sourceFile: 'supabase/functions/ga4-click-to-call-sync/index.ts'
  },
  {
    id: 'ai-source-patterns-sync',
    name: 'AI Source Patterns Sync',
    slug: 'ai-source-patterns-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Maintains canonical list of AI assistant referrers (ChatGPT, Claude, Perplexity) and discovers newly launched AI referral tools into public.ai_source_patterns.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Monthly · 2nd of Month 6:00 AM PH (22:00 UTC)',
    cronName: 'ai-source-patterns-sync-monthly',
    cronExpression: '0 22 1 * *',
    targetTables: ['public.ai_source_patterns'],
    sourceFile: 'supabase/functions/ai-source-patterns-sync/index.ts'
  },

  // --- Financial & Accounting Automations ---
  {
    id: 'xero-ad-spend-sync',
    name: 'Xero Ad Spend Sync',
    slug: 'xero-ad-spend-sync',
    type: 'edge_function',
    category: 'Operations',
    description: 'Extracts actual card & debit spend for Bing Ads and Simple Digital marketing management fees directly from Xero P&L accounts into public.xero_ad_spend_monthly_raw.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Weekly · Mon 6:30 AM PH (Sun 22:30 UTC)',
    cronName: 'xero-ad-spend-sync-weekly',
    cronExpression: '30 22 * * 0',
    targetTables: ['public.xero_ad_spend_monthly_raw'],
    sourceFile: 'supabase/functions/xero-ad-spend-sync/index.ts'
  },
  {
    id: 'xero-channel-summary-sync',
    name: 'Xero Channel Summary Sync',
    slug: 'xero-channel-summary-sync',
    type: 'edge_function',
    category: 'Operations',
    description: 'Pulls reconciled spend transactions from Xero P&L expense accounts mapped to marketing vendor channels, refreshing public.marketing_channel_summary.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Monthly · 3rd of Month 6:00 AM PH (22:00 UTC)',
    cronName: 'xero-channel-summary-sync-monthly',
    cronExpression: '0 22 2 * *',
    targetTables: ['public.marketing_channel_summary'],
    sourceFile: 'supabase/functions/xero-channel-summary-sync/index.ts'
  },
  {
    id: 'invoice-tracking-sync',
    name: 'Invoice Tracking Sync',
    slug: 'invoice-tracking-sync',
    type: 'edge_function',
    category: 'Operations',
    description: 'Reads Xero invoices and matches invoice lines against AC won deals and buyer analysis entries to verify payment status and tracking.',
    triggerType: 'On-Demand',
    scheduleDesc: 'On-Demand / Webhook triggered',
    cronName: null,
    cronExpression: null,
    targetTables: ['public.invoice_tracking'],
    sourceFile: 'supabase/functions/invoice-tracking-sync'
  },
  {
    id: 'xero-oauth-callback',
    name: 'Xero OAuth Token Receiver',
    slug: 'xero-oauth-callback',
    type: 'edge_function',
    category: 'System',
    description: 'Receives OAuth2 authorization code callbacks from Xero, exchanges them for access/refresh tokens, and persists encrypted tokens to public.oauth_token_store.',
    triggerType: 'Webhook',
    scheduleDesc: 'Webhook only (Xero OAuth callback URL)',
    cronName: null,
    cronExpression: null,
    targetTables: ['public.oauth_token_store'],
    sourceFile: 'supabase/functions/xero-oauth-callback/index.ts'
  },

  // --- Social Media & Content ---
  {
    id: 'apify-platforms-sync',
    name: 'Apify Social Platforms Sync',
    slug: 'apify-platforms-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Scrapes public social metrics (YouTube, LinkedIn, Instagram followers, posts, engagement rates) via Apify actors into public.social_platform_stats.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Weekly · Mon 4:00 AM PH (Sun 20:00 UTC)',
    cronName: 'apify-platforms-sync-weekly',
    cronExpression: '0 20 * * 0',
    targetTables: ['public.social_platform_stats'],
    sourceFile: 'supabase/functions/apify-platforms-sync/index.ts'
  },
  {
    id: 'linkedin-newsletter-sync',
    name: 'LinkedIn Newsletter Sync',
    slug: 'linkedin-newsletter-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Fetches LinkedIn newsletter subscriber counts via session cookies and updates public.content_social_metrics.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Weekly · Mon 4:30 AM PH (Sun 20:30 UTC)',
    cronName: 'linkedin-newsletter-sync-weekly',
    cronExpression: '30 20 * * 0',
    targetTables: ['public.content_social_metrics'],
    sourceFile: 'supabase/functions/linkedin-newsletter-sync/index.ts'
  },
  {
    id: 'weekly-reviews-sync',
    name: 'Google Reviews Sync',
    slug: 'weekly-reviews-sync',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Syncs Google Business reviews, ratings, and customer sentiment into public.google_reviews.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Weekly · Mon 11:00 PM PH (15:00 UTC)',
    cronName: 'weekly-reviews-sync',
    cronExpression: '0 15 * * 1',
    targetTables: ['public.google_reviews'],
    sourceFile: 'supabase/functions/weekly-reviews-sync'
  },
  {
    id: 'sync-insta-stories',
    name: 'Instagram Stories Sync',
    slug: 'sync-insta-stories',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Synchronizes published Instagram stories and media content into cloud storage and database for historical tracking.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Mon–Fri 6:20 AM PH (22:20 UTC)',
    cronName: 'sync-insta-stories',
    cronExpression: '20 22 * * 0-4',
    targetTables: ['public.instagram_stories'],
    sourceFile: 'supabase/functions/sync-insta-stories'
  },
  {
    id: 'analyze-insta-stories',
    name: 'Instagram Stories AI Analyzer',
    slug: 'analyze-insta-stories',
    type: 'edge_function',
    category: 'Marketing',
    description: 'Runs AI transcription and thematic classification on newly synced Instagram stories.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Mon–Fri 6:30 AM PH (22:30 UTC)',
    cronName: 'analyze-insta-stories-daily',
    cronExpression: '30 22 * * 0-4',
    targetTables: ['public.instagram_story_analysis'],
    sourceFile: 'supabase/functions/analyze-insta-stories'
  },

  // --- Webhooks & Lead Processors ---
  {
    id: 'process-bounced-leads',
    name: 'Process Bounced Leads',
    slug: 'process-bounced-leads',
    type: 'edge_function',
    category: 'Sales',
    description: 'Receives webhook notifications from ActiveCampaign when emails bounce, flagging contacts and preventing wasted delivery.',
    triggerType: 'Webhook',
    scheduleDesc: 'Webhook only (ActiveCampaign email bounce event)',
    cronName: null,
    cronExpression: null,
    targetTables: ['public.activecampaign_contacts'],
    sourceFile: 'supabase/functions/process-bounced-leads'
  },
  {
    id: 'alternate-lead-finder',
    name: 'Alternate Lead Finder',
    slug: 'alternate-lead-finder',
    type: 'edge_function',
    category: 'Sales',
    description: 'Automated search routine searching for alternate contact persons at target accounts where existing leads are unresponsive.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Weekly · Mon 6:55 AM PH (Sun 22:55 UTC)',
    cronName: 'alternate-lead-finder-weekly',
    cronExpression: '55 22 * * 0',
    targetTables: ['public.alternate_contacts'],
    sourceFile: 'supabase/functions/alternate-lead-finder'
  },
  {
    id: 'process-unresponsive-lost-leads',
    name: 'Process Unresponsive Lost Leads',
    slug: 'process-unresponsive-lost-leads',
    type: 'edge_function',
    category: 'Sales',
    description: 'Weekly scanner for deals stalled in Lost status, preparing re-engagement cohorts for marketing campaigns.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Weekly · Mon 6:30 AM PH (Sun 22:30 UTC)',
    cronName: 'process-unresponsive-lost-leads-weekly',
    cronExpression: '30 22 * * 0',
    targetTables: ['public.activecampaign_deals'],
    sourceFile: 'supabase/functions/process-unresponsive-lost-leads'
  },
  {
    id: 'ac-poc-position-sync',
    name: 'AC POC Position Sync',
    slug: 'ac-poc-position-sync',
    type: 'edge_function',
    category: 'Sales',
    description: 'Webhook listener updating job title, hierarchy, and seniority data for ActiveCampaign points of contact.',
    triggerType: 'Webhook',
    scheduleDesc: 'Webhook only (AC contact update)',
    cronName: null,
    cronExpression: null,
    targetTables: ['public.activecampaign_contacts'],
    sourceFile: 'supabase/functions/ac-poc-position-sync'
  },
  {
    id: 'ac-account-contact-sync',
    name: 'AC Account-Contact Link Sync',
    slug: 'ac-account-contact-sync',
    type: 'edge_function',
    category: 'Sales',
    description: 'Webhook listener keeping corporate account relationships synchronized with individual contacts in ActiveCampaign.',
    triggerType: 'Webhook',
    scheduleDesc: 'Webhook only (AC account association)',
    cronName: null,
    cronExpression: null,
    targetTables: ['public.activecampaign_accounts'],
    sourceFile: 'supabase/functions/ac-account-contact-sync'
  },
  {
    id: 'renew-gmail-watch',
    name: 'Renew Gmail Watch',
    slug: 'renew-gmail-watch',
    type: 'edge_function',
    category: 'System',
    description: 'Daily maintenance renewal of Google Cloud Pub/Sub push watch on the James / Julienne Gmail inboxes so enquiry webhooks stay active.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Daily 10:00 AM PH (02:00 UTC)',
    cronName: 'renew-gmail-watch-daily',
    cronExpression: '0 2 * * *',
    targetTables: ['System / Cloud PubSub'],
    sourceFile: 'supabase/functions/renew-gmail-watch'
  },
  {
    id: 'draft-james-reply',
    name: 'Draft James Reply AI',
    slug: 'draft-james-reply',
    type: 'edge_function',
    category: 'Sales',
    description: 'AI email assistant triggered on incoming Gmail push notifications to generate contextual response drafts for James.',
    triggerType: 'Webhook',
    scheduleDesc: 'Webhook only (Gmail Pub/Sub push notification)',
    cronName: null,
    cronExpression: null,
    targetTables: ['System / Gmail Drafts'],
    sourceFile: 'supabase/functions/draft-james-reply'
  },

  // --- Scheduled Database Procedures (pg_cron SQL) ---
  {
    id: 'update-deals-daily-7am-pht',
    name: 'GA4 Deal Attribution Reconciler',
    slug: 'update_ga4_contact_deals',
    type: 'sql_procedure',
    category: 'Marketing',
    description: 'Postgres stored procedure (public.update_ga4_contact_deals) reconciling ActiveCampaign deal attribution with GA4 conversion events and updating matching deal columns.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Daily 7:00 AM PH (23:00 UTC)',
    cronName: 'update-deals-daily-7am-pht',
    cronExpression: '0 23 * * *',
    targetTables: ['public.ga4_contact_deals'],
    sourceFile: 'supabase/migrations/20261013000000_denormalize_deal_cols_in_update_ga4_contact_deals.sql'
  },
  {
    id: 'calendly-booking-channel-reconcile-daily',
    name: 'Calendly Booking Channel Reconciler',
    slug: 'reconcile_calendly_booking_channels',
    type: 'sql_procedure',
    category: 'Marketing',
    description: 'Postgres stored procedure (public.reconcile_calendly_booking_channels) reconciling Calendly booking channel attribution with GA4 event records.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Daily 6:15 AM PH (22:15 UTC)',
    cronName: 'calendly-booking-channel-reconcile-daily',
    cronExpression: '15 22 * * *',
    targetTables: ['public.calendly_bookings'],
    sourceFile: 'supabase/migrations/20261014000100_calendly_channel_from_booking.sql'
  },
  {
    id: 'post-conference-deals-sync-daily',
    name: 'Post-Conference Deals Reconciler',
    slug: 'reload_post_conference_deals',
    type: 'sql_procedure',
    category: 'Sales',
    description: 'Postgres stored procedure (public.reload_post_conference_deals) refreshing conference pipeline 17 deals for the nurture and post-conference tracking page.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Daily 6:30 AM PH (22:30 UTC)',
    cronName: 'post-conference-deals-sync-daily',
    cronExpression: '30 22 * * *',
    targetTables: ['public.post_conference_deals'],
    sourceFile: 'supabase/migrations/20261109170000_create_post_conference_deals.sql'
  }
];

/**
 * Execute a read-only query using Postgres pool if configured, or Supabase Management API fallback.
 */
async function executeQuery(sql) {
  if (supabaseConfigured()) {
    return await q(sql);
  }

  // Fallback for local development using SUPABASE_ACCESS_TOKEN if DB URL is not set
  const token = config.supabase.accessToken;
  const projectId = config.supabase.projectId || 'aivitcomiywiysrfwqxt';
  if (token) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectId}/database/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: sql })
    });
    if (res.ok) {
      return await res.json();
    }
    console.warn('[db-automations] Management API query failed with status', res.status);
  }

  throw new Error('Supabase database connection not available (neither SUPABASE_DB_URL nor SUPABASE_ACCESS_TOKEN is configured).');
}

/**
 * Correlates cron job info and HTTP response logs to produce accurate last run status and notes.
 */
function synthesizeRunTelemetry(item, cronJob, httpResponses) {
  // If this item is webhook / on-demand only
  if (item.triggerType !== 'Scheduled') {
    return {
      status: 'active',
      statusLabel: 'Active / Listening',
      lastRunAt: null,
      lastRunNotes: item.triggerType === 'Webhook' 
        ? 'Active · Waiting for webhook event trigger (Ready)'
        : 'Active · Ready for on-demand trigger (Ready)',
      durationMs: null,
      httpStatusCode: null,
      rawOutput: null
    };
  }

  // For scheduled items, if no cron job is registered in pg_cron
  if (!cronJob) {
    return {
      status: 'pending',
      statusLabel: 'Pending Schedule',
      lastRunAt: null,
      lastRunNotes: 'Pending · Scheduled in migrations, awaiting activation',
      durationMs: null,
      httpStatusCode: null,
      rawOutput: null
    };
  }

  const lastRunAt = cronJob.start_time ? new Date(cronJob.start_time).toISOString() : null;
  const isSqlProc = item.type === 'sql_procedure' || !((cronJob.command || '').includes('net.http_'));

  // 1. Check for pg_cron level failure
  if (cronJob.run_status === 'failed') {
    return {
      status: 'failed',
      statusLabel: 'Failed',
      lastRunAt,
      lastRunNotes: `Failed · pg_cron error: ${cronJob.return_message || 'Execution failed'}`,
      durationMs: null,
      httpStatusCode: null,
      rawOutput: cronJob.return_message
    };
  }

  // 2. If it's a pure SQL stored procedure
  if (isSqlProc) {
    if (cronJob.run_status === 'succeeded') {
      return {
        status: 'succeeded',
        statusLabel: 'Succeeded',
        lastRunAt,
        lastRunNotes: `Succeeded · Stored procedure executed successfully (${cronJob.return_message || '1 row'})`,
        durationMs: null,
        httpStatusCode: 200,
        rawOutput: cronJob.return_message
      };
    }
  }

  // 3. For HTTP-based Edge Functions, search for matching HTTP response in net._http_response
  let matchedHttp = null;
  const jobCmd = cronJob.command || '';

  for (const resp of httpResponses) {
    if (!resp.content && !resp.error_msg) continue;
    try {
      const parsed = typeof resp.content === 'string' ? JSON.parse(resp.content) : resp.content;
      if (parsed) {
        if (parsed.fn && (jobCmd.includes(parsed.fn) || item.slug === parsed.fn)) {
          matchedHttp = { resp, parsed };
          break;
        }
        if (parsed.table && (jobCmd.includes(parsed.table) || item.targetTables.some(t => t.includes(parsed.table)))) {
          matchedHttp = { resp, parsed };
          break;
        }
      }
    } catch (e) {
      if (resp.content && item.slug === 'contact-sources-sync' && resp.content.includes('Contact Sources')) {
        matchedHttp = { resp, parsed: { message: resp.content } };
        break;
      }
    }
  }

  // Fallback match by timestamp proximity (within 10 seconds of job start)
  if (!matchedHttp && cronJob.start_time && !isSqlProc) {
    const jobStart = new Date(cronJob.start_time).getTime();
    for (const resp of httpResponses) {
      const respTime = new Date(resp.created).getTime();
      if (Math.abs(jobStart - respTime) < 10000) {
        try {
          const parsed = typeof resp.content === 'string' ? JSON.parse(resp.content) : null;
          matchedHttp = { resp, parsed };
          break;
        } catch {}
      }
    }
  }

  if (matchedHttp) {
    const { resp, parsed } = matchedHttp;
    const httpStatusCode = resp.status_code || null;

    if (resp.error_msg) {
      const errMsg = resp.error_msg.split('.')[0];
      return {
        status: 'warning',
        statusLabel: 'Warning / Timeout',
        lastRunAt,
        lastRunNotes: `Warning · HTTP request error: ${errMsg}`,
        durationMs: null,
        httpStatusCode,
        rawOutput: resp.error_msg
      };
    }

    if (parsed) {
      if (parsed.ok === true && parsed.reloaded_rows !== undefined) {
        const dur = parsed.duration_ms ? ` in ${(parsed.duration_ms / 1000).toFixed(1)}s` : '';
        const pages = parsed.pages ? ` (${parsed.pages} pages)` : '';
        return {
          status: 'succeeded',
          statusLabel: 'Succeeded',
          lastRunAt,
          lastRunNotes: `Succeeded (HTTP 200) · ${parsed.reloaded_rows.toLocaleString()} rows synced${dur}${pages}`,
          durationMs: parsed.duration_ms || null,
          httpStatusCode: 200,
          rawOutput: parsed
        };
      }
      if (parsed.ok === true && parsed.upserted !== undefined) {
        return {
          status: 'succeeded',
          statusLabel: 'Succeeded',
          lastRunAt,
          lastRunNotes: `Succeeded (HTTP 200) · ${parsed.upserted} rows upserted to ${parsed.table || 'database'}`,
          durationMs: null,
          httpStatusCode: 200,
          rawOutput: parsed
        };
      }
      if (parsed.mode === 'async' || parsed.status === 'accepted') {
        return {
          status: 'succeeded',
          statusLabel: 'Succeeded (Async)',
          lastRunAt,
          lastRunNotes: 'Succeeded (HTTP 202 Accepted) · Background sync triggered and accepted',
          durationMs: null,
          httpStatusCode: 202,
          rawOutput: parsed
        };
      }
      if (parsed.message) {
        return {
          status: 'succeeded',
          statusLabel: 'Succeeded',
          lastRunAt,
          lastRunNotes: `Succeeded (HTTP 202) · ${parsed.message}`,
          durationMs: null,
          httpStatusCode: 202,
          rawOutput: parsed
        };
      }
      if (resp.status_code === 207) {
        const errCount = (parsed.errors && parsed.errors.length) || 0;
        return {
          status: 'warning',
          statusLabel: 'Partial Warning',
          lastRunAt,
          lastRunNotes: `Warning (HTTP 207) · ${parsed.bookings_processed || 0} processed with ${errCount} note(s)`,
          durationMs: null,
          httpStatusCode: 207,
          rawOutput: parsed
        };
      }
    }

    if (resp.status_code === 200) {
      return {
        status: 'succeeded',
        statusLabel: 'Succeeded',
        lastRunAt,
        lastRunNotes: 'Succeeded (HTTP 200 OK)',
        durationMs: null,
        httpStatusCode: 200,
        rawOutput: resp.content
      };
    }
  }

  // 4. Default for pg_cron job when no specific HTTP body was found
  if (cronJob.run_status === 'succeeded') {
    return {
      status: 'succeeded',
      statusLabel: 'Succeeded',
      lastRunAt,
      lastRunNotes: `Succeeded · Scheduled job executed successfully (${cronJob.return_message || '1 row'})`,
      durationMs: null,
      httpStatusCode: 200,
      rawOutput: cronJob.return_message
    };
  }

  if (!cronJob.start_time) {
    return {
      status: 'pending',
      statusLabel: 'Awaiting Run',
      lastRunAt: null,
      lastRunNotes: 'Scheduled · Awaiting initial execution window',
      durationMs: null,
      httpStatusCode: null,
      rawOutput: null
    };
  }

  return {
    status: 'active',
    statusLabel: 'Active',
    lastRunAt,
    lastRunNotes: 'Active · Ready for scheduled execution',
    durationMs: null,
    httpStatusCode: null,
    rawOutput: null
  };
}

/**
 * Returns complete telemetry and status for all active database automations.
 */
export async function getDbAutomations() {
  let cronJobs = [];
  let httpResponses = [];

  try {
    const cronSql = `
      SELECT 
        j.jobid,
        j.jobname,
        j.schedule,
        j.active,
        j.command,
        d.runid,
        d.status as run_status,
        d.return_message,
        d.start_time,
        d.end_time
      FROM cron.job j
      LEFT JOIN LATERAL (
        SELECT runid, status, return_message, start_time, end_time
        FROM cron.job_run_details
        WHERE jobid = j.jobid
        ORDER BY start_time DESC
        LIMIT 1
      ) d ON true
      ORDER BY j.jobname;
    `;
    cronJobs = await executeQuery(cronSql);
  } catch (err) {
    console.error('[db-automations] Failed to query cron.job:', err.message);
  }

  try {
    const httpSql = `
      SELECT id, status_code, error_msg, content, created
      FROM net._http_response
      ORDER BY id DESC
      LIMIT 40;
    `;
    httpResponses = await executeQuery(httpSql);
  } catch (err) {
    console.error('[db-automations] Failed to query net._http_response:', err.message);
  }

  // Index cron jobs by jobname and by command URL
  const cronByName = new Map();
  for (const job of cronJobs) {
    if (job.jobname) cronByName.set(job.jobname.toLowerCase(), job);
  }

  // Process each catalog item
  const automations = AUTOMATIONS_CATALOG.map((item) => {
    let matchedCron = null;
    if (item.cronName) {
      matchedCron = cronByName.get(item.cronName.toLowerCase()) || null;
    }
    if (!matchedCron) {
      // Try searching command
      matchedCron = cronJobs.find((j) => (j.command || '').includes(item.slug)) || null;
    }

    const telemetry = synthesizeRunTelemetry(item, matchedCron, httpResponses);

    return {
      id: item.id,
      name: item.name,
      slug: item.slug,
      type: item.type,
      category: item.category,
      description: item.description,
      triggerType: item.triggerType,
      scheduleDesc: item.scheduleDesc,
      cronExpression: item.cronExpression,
      cronActive: matchedCron ? matchedCron.active : (item.triggerType === 'Scheduled' ? false : true),
      jobId: matchedCron ? matchedCron.jobid : null,
      targetTables: item.targetTables,
      sourceFile: item.sourceFile,
      status: telemetry.status,
      statusLabel: telemetry.statusLabel,
      lastRunAt: telemetry.lastRunAt,
      lastRunNotes: telemetry.lastRunNotes,
      durationMs: telemetry.durationMs,
      httpStatusCode: telemetry.httpStatusCode,
      rawOutput: telemetry.rawOutput
    };
  });

  // Calculate summary counts
  const total = automations.length;
  const scheduled = automations.filter(a => a.triggerType === 'Scheduled').length;
  const webhook = automations.filter(a => a.triggerType !== 'Scheduled').length;
  const succeeded = automations.filter(a => a.status === 'succeeded' || a.status === 'active').length;
  const issues = automations.filter(a => a.status === 'failed' || a.status === 'warning').length;

  return {
    summary: {
      total,
      scheduled,
      webhook,
      succeeded,
      issues,
      healthyPct: total > 0 ? Math.round((succeeded / total) * 100) : 100
    },
    automations,
    lastPolledAt: new Date().toISOString()
  };
}
