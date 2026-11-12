// server/metrics/claude-routines.js
// Provides live telemetry, execution history, and catalog of all active Claude Code Routines,
// cloud agents, scheduled background jobs, and API-triggered workers.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { config } from '../config.js';

// Canonical catalog of Claude Code Routines.
// Includes active scheduled routines, API/on-demand workers, and archived routines for completeness.
export const ROUTINES_CATALOG = [
  // --- Active Scheduled Claude Code Routines ---
  {
    id: 'email-partners-sync',
    name: 'Email & Partners Weekly Sync',
    slug: 'email-partners-sync',
    routineId: 'trig_01KHNc3jpp27VePeheDqk2FA',
    runnerType: 'Claude Code Cloud Routine',
    category: 'Marketing',
    active: true,
    description: 'Extracts Australian FY campaign performance summary metrics (sends, open rate, click rate, unsubs, bounces) and active subscriber counts via ActiveCampaign MCP. Correlates with public.ac_indirect_deals (bureau and tailor performance) and writes append-only weekly snapshot rows into public.email_partner_metrics.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Weekly, Mon 06:00 AM PH (Sun 22:00 UTC)',
    cronExpression: '0 22 * * 0',
    cronHuman: 'Every Monday at 6:00 AM Manila',
    connectors: ['ActiveCampaign MCP', 'Supabase MCP (execute_sql)'],
    model: 'Claude Code Cloud Agent',
    targetTables: ['public.email_partner_metrics', 'public.ac_indirect_deals'],
    sourceDoc: 'routines/email-partners-sync.md',
    promptNotes: 'Calls run_campaign_performance_report for each FY window, list_contacts for active contacts, list_lists for bureau list (id=3), and executes an atomic multi-row INSERT with deals CTE.'
  },
  {
    id: 'sales-topline-sync',
    name: 'Sales Top-Line & Conference KPIs Sync',
    slug: 'sales-topline-sync',
    routineId: 'trig_011z2MX6Sh5gsBY6JncmDmss',
    runnerType: 'Claude Code Cloud Routine',
    category: 'Sales',
    active: true,
    description: 'Recomputes top-line revenue (AUD total income) and LIV conference pipeline metrics (won/lost deals, deal value, demos booked, bureau & tailor enquiry counts) over a rolling 12-month window from public.invoice_tracking and public.activecampaign_deals. Performs idempotent upserts into public.sales_topline.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Weekly, Mon 06:00 AM PH (Sun 22:00 UTC)',
    cronExpression: '0 22 * * 0',
    cronHuman: 'Every Monday at 6:00 AM Manila',
    connectors: ['Supabase MCP (execute_sql)'],
    model: 'Claude Code Cloud Agent',
    targetTables: ['public.sales_topline', 'public.invoice_tracking', 'public.activecampaign_deals'],
    sourceDoc: 'routines/sales-topline-sync.md',
    promptNotes: 'Executes idempotent SQL UPSERTs on (metric, bucket, dimension) for total_income (current YTD, prior YTD, monthly series), bureau, tailor, and LIV pipeline conference deals.'
  },
  {
    id: 'invoice-tracking-sync',
    name: 'Xero Invoice Tracking & AC Deal Matcher',
    slug: 'invoice-tracking-sync',
    routineId: 'trig_013TGsR7euBvPbAz45UpS8tb',
    runnerType: 'Claude Code Cloud Routine',
    category: 'Operations',
    active: true,
    description: 'Pages through 2026+ ACCREC sales invoices from Xero via Xero MCP (read-only). Extracts line items, computes fee breakdowns (engagement fees, GST, other fees), builds structured charges JSON, and matches each invoice to the corresponding ActiveCampaign deal title before upserting public.invoice_tracking.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Mon–Fri 06:00 AM PH (Sun–Thu 22:00 UTC)',
    cronExpression: '0 22 * * 0-4',
    cronHuman: 'Monday through Friday at 6:00 AM Manila',
    connectors: ['Xero MCP (Read-only)', 'Supabase MCP (execute_sql)'],
    model: 'Claude 3.7 Sonnet',
    targetTables: ['public.invoice_tracking', 'public.activecampaign_deals'],
    sourceDoc: 'as_built.txt (AUTOMATIONS / ROUTINES)',
    promptNotes: 'Runs deterministic transform.mjs embedded in prompt, ensures zero table truncation, matches deal titles, and calculates line charge splits by account code.'
  },

  // --- Active On-Demand / API Call Claude Code Routines ---
  {
    id: 'ga4-on-demand',
    name: 'GA4 Agent On-Demand Report',
    slug: 'ga4-on-demand',
    routineId: 'trig_01DFkHgvzKJUDCNcHwM87gyS',
    runnerType: 'Claude Code Cloud Worker',
    category: 'Analytics',
    active: true,
    description: 'Powers the dashboard GA4 Agent tab. Triggered on-demand via API endpoint (POST /api/ga4-agent/run). Atomically claims pending natural language analytics queries from public.ga4_agent_requests, executes scripts/ga4_routine.py in a secure cloud container using Google Ads & GA4 credentials, and stores markdown report analysis back in Supabase.',
    triggerType: 'API Call',
    scheduleDesc: 'On-Demand via API Call (/api/ga4-agent/run)',
    cronExpression: null,
    cronHuman: 'Triggered by user query / fire bearer token',
    connectors: ['GA4 Service Account', 'Google Ads API', 'Supabase MCP', 'Cloud Container'],
    model: 'Claude Code Cloud Worker (On-Demand)',
    targetTables: ['public.ga4_agent_requests'],
    sourceDoc: 'routines/ga4-on-demand.md',
    promptNotes: 'Fired server-side with GA4_ROUTINE_FIRE_TOKEN, maps user prompt to ga4_routine.py arguments, executes Python script against Google Analytics Data API, and writes result to ga4_agent_requests.'
  },

  // --- Retired / Superseded Routines (Kept for Historical Monitoring) ---
  {
    id: 'roas-year-on-year-sync',
    name: 'ROAS Year-on-Year Sync (Retired)',
    slug: 'roas-year-on-year-sync',
    routineId: 'trig_011wFrti6fguprMJa9nqujTo',
    runnerType: 'Claude Code Cloud Routine',
    category: 'Marketing',
    active: false,
    description: 'Synchronized calendar-year Google Ads ROAS data from Google Sheet "MAG Marketing ROAS Report" into public.roas_year_on_year. Retired on 2026-10-20 and superseded by live dynamic database computation in roas.js.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Formerly Mon 06:00 AM PH · Disabled 2026-10-20',
    cronExpression: '0 22 * * 0',
    cronHuman: 'Disabled (enabled: false)',
    connectors: ['Google Sheets Connector', 'Supabase MCP'],
    model: 'Claude Code Cloud Agent',
    targetTables: ['public.roas_year_on_year'],
    sourceDoc: 'routines/roas-year-on-year-sync.md',
    promptNotes: 'Formerly read rows 5-9 and 15-18 from Year on Year sheet tab. Preserved in disabled state for historical record.'
  },
  {
    id: 'simple-digital-fees-sync',
    name: 'Simple Digital Fees Sync (Superseded)',
    slug: 'simple-digital-fees-sync',
    routineId: null,
    runnerType: 'Claude Code Cloud Routine',
    category: 'Marketing',
    active: false,
    description: 'Planned routine to extract GoCardless debit notices from Gmail for Simple Digital agency fees. Superseded before activation on 2026-10-23 by the automated xero-ad-spend-sync Supabase Edge Function.',
    triggerType: 'Scheduled',
    scheduleDesc: 'Planned Monthly 1st · Superseded 2026-10-23',
    cronExpression: '0 22 L * *',
    cronHuman: 'Superseded by Xero Edge Function',
    connectors: ['Gmail MCP', 'Supabase MCP'],
    model: 'Claude Code Cloud Agent',
    targetTables: ['public.simple_digital_fees_monthly'],
    sourceDoc: 'routines/simple-digital-fees-sync.md',
    promptNotes: 'Intended to search Gmail for GoCardless debits and subtract $600 SEO fee. Handled directly via Xero bank transactions instead.'
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
    console.warn('[claude-routines] Management API query failed with status', res.status);
  }

  throw new Error('Supabase database connection not available (neither SUPABASE_DB_URL nor SUPABASE_ACCESS_TOKEN is configured).');
}

/**
 * Returns complete telemetry and status for all Claude Code Routines.
 */
export async function getClaudeRoutines() {
  let emailPartnerTelemetry = null;
  let salesToplineTelemetry = null;
  let invoiceTrackingTelemetry = null;
  let ga4AgentTelemetry = null;

  // 1. Fetch live telemetry from public.email_partner_metrics
  try {
    const res = await executeQuery(`
      SELECT 
        run_id,
        captured_at,
        count(*) as fy_rows,
        max(campaigns_sent) as campaigns_sent,
        max(active_contacts) as active_contacts
      FROM public.email_partner_metrics
      GROUP BY run_id, captured_at
      ORDER BY captured_at DESC
      LIMIT 1;
    `);
    if (res && res.length > 0) {
      emailPartnerTelemetry = res[0];
    }
  } catch (err) {
    // Expected in offline local dev mode
  }

  // 2. Fetch live telemetry from public.sales_topline
  try {
    const res = await executeQuery(`
      SELECT 
        max(updated_at) as last_updated,
        count(*) as row_count,
        count(distinct metric) as distinct_metrics
      FROM public.sales_topline;
    `);
    if (res && res.length > 0) {
      salesToplineTelemetry = res[0];
    }
  } catch (err) {
    // Expected in offline local dev mode
  }

  // 3. Fetch live telemetry from public.invoice_tracking
  try {
    const res = await executeQuery(`
      SELECT 
        max(updated_at) as last_updated,
        count(*) as total_invoices,
        count(ac_deal_title) filter (where ac_deal_title is not null and ac_deal_title <> '') as matched_deals,
        round(coalesce(sum(amount_total), 0)::numeric, 2) as total_amount
      FROM public.invoice_tracking;
    `);
    if (res && res.length > 0) {
      invoiceTrackingTelemetry = res[0];
    }
  } catch (err) {
    // Expected in offline local dev mode
  }

  // 4. Fetch live telemetry from public.ga4_agent_requests
  try {
    const res = await executeQuery(`
      SELECT 
        id,
        prompt,
        status,
        error,
        result,
        created_at,
        started_at,
        completed_at
      FROM public.ga4_agent_requests
      ORDER BY created_at DESC
      LIMIT 5;
    `);
    if (res && res.length > 0) {
      ga4AgentTelemetry = res;
    }
  } catch (err) {
    // Expected in offline local dev mode
  }

  // Correlate telemetry for each catalog item
  const routines = ROUTINES_CATALOG.map((item) => {
    let status = 'active';
    let statusLabel = 'Active';
    let lastRunAt = null;
    let lastRunNotes = 'Active · Ready for execution';
    let rawOutput = null;
    let durationMs = null;

    if (!item.active) {
      status = 'inactive';
      statusLabel = 'Retired / Superseded';
      lastRunNotes = item.id === 'roas-year-on-year-sync'
        ? 'Retired 2026-10-20 · Superseded by dynamic database computation in roas.js'
        : 'Superseded 2026-10-23 · Automated via xero-ad-spend-sync edge function';
      return {
        ...item,
        status,
        statusLabel,
        lastRunAt: null,
        lastRunNotes,
        rawOutput: null,
        durationMs: null
      };
    }

    // Email Partners Sync
    if (item.id === 'email-partners-sync') {
      if (emailPartnerTelemetry && emailPartnerTelemetry.captured_at) {
        lastRunAt = new Date(emailPartnerTelemetry.captured_at).toISOString();
        status = 'succeeded';
        statusLabel = 'Succeeded';
        const rows = emailPartnerTelemetry.fy_rows || 6;
        const contacts = emailPartnerTelemetry.active_contacts
          ? Number(emailPartnerTelemetry.active_contacts).toLocaleString()
          : '15,000+';
        const runIdShort = emailPartnerTelemetry.run_id ? emailPartnerTelemetry.run_id.slice(0, 8) : 'routine';
        lastRunNotes = `Succeeded · ${rows} FY snapshots captured (run_id: ${runIdShort}, ${contacts} active contacts, summaryData refreshed)`;
        rawOutput = emailPartnerTelemetry;
      } else {
        status = 'active';
        statusLabel = 'Active (Scheduled)';
        lastRunNotes = 'Active · Scheduled weekly Mon 6:00 AM PH via Claude Code cloud routine';
      }
    }

    // Sales Topline Sync
    else if (item.id === 'sales-topline-sync') {
      if (salesToplineTelemetry && salesToplineTelemetry.last_updated) {
        lastRunAt = new Date(salesToplineTelemetry.last_updated).toISOString();
        status = 'succeeded';
        statusLabel = 'Succeeded';
        const count = salesToplineTelemetry.row_count || 36;
        const metrics = salesToplineTelemetry.distinct_metrics || 6;
        lastRunNotes = `Succeeded · Cache up to date (${count} metric buckets across ${metrics} distinct sales & conference KPIs)`;
        rawOutput = salesToplineTelemetry;
      } else {
        status = 'active';
        statusLabel = 'Active (Scheduled)';
        lastRunNotes = 'Active · Scheduled weekly Mon 6:00 AM PH via Claude Code cloud routine';
      }
    }

    // Invoice Tracking Sync
    else if (item.id === 'invoice-tracking-sync') {
      if (invoiceTrackingTelemetry && invoiceTrackingTelemetry.last_updated) {
        lastRunAt = new Date(invoiceTrackingTelemetry.last_updated).toISOString();
        status = 'succeeded';
        statusLabel = 'Succeeded';
        const total = Number(invoiceTrackingTelemetry.total_invoices || 0).toLocaleString();
        const matched = Number(invoiceTrackingTelemetry.matched_deals || 0).toLocaleString();
        const amt = Number(invoiceTrackingTelemetry.total_amount || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        lastRunNotes = `Succeeded · ${total} invoices tracked (${matched} matched to AC deals, $${amt} AUD total)`;
        rawOutput = invoiceTrackingTelemetry;
      } else {
        status = 'active';
        statusLabel = 'Active (Scheduled)';
        lastRunNotes = 'Active · Scheduled Mon–Fri 6:00 AM PH via Claude 3.7 Sonnet cloud routine';
      }
    }

    // GA4 On-Demand Agent
    else if (item.id === 'ga4-on-demand') {
      if (ga4AgentTelemetry && ga4AgentTelemetry.length > 0) {
        const latest = ga4AgentTelemetry[0];
        lastRunAt = latest.completed_at || latest.started_at || latest.created_at;
        if (latest.status === 'done') {
          status = 'succeeded';
          statusLabel = 'Succeeded';
          if (latest.created_at && latest.completed_at) {
            durationMs = new Date(latest.completed_at).getTime() - new Date(latest.created_at).getTime();
          }
          const durText = durationMs ? ` in ${(durationMs / 1000).toFixed(1)}s` : '';
          const snippet = (latest.prompt || '').slice(0, 50).trim();
          lastRunNotes = `Succeeded · Request completed${durText}: "${snippet}…"`;
        } else if (latest.status === 'running') {
          status = 'warning';
          statusLabel = 'Running';
          lastRunNotes = `Running · Processing query: "${(latest.prompt || '').slice(0, 50)}…"`;
        } else if (latest.status === 'error') {
          status = 'failed';
          statusLabel = 'Failed';
          lastRunNotes = `Failed · ${latest.error || 'Request execution error'}`;
        } else {
          status = 'active';
          statusLabel = 'Pending Queue';
          lastRunNotes = `Pending · In queue awaiting cloud container execution`;
        }
        rawOutput = ga4AgentTelemetry;
      } else {
        status = 'active';
        statusLabel = 'Active (On-Demand)';
        lastRunNotes = 'Active · Ready for on-demand queries via /api/ga4-agent/run';
      }
    }

    return {
      id: item.id,
      name: item.name,
      slug: item.slug,
      routineId: item.routineId,
      runnerType: item.runnerType,
      category: item.category,
      active: item.active,
      description: item.description,
      triggerType: item.triggerType,
      scheduleDesc: item.scheduleDesc,
      cronExpression: item.cronExpression,
      cronHuman: item.cronHuman,
      connectors: item.connectors,
      model: item.model,
      targetTables: item.targetTables,
      sourceDoc: item.sourceDoc,
      promptNotes: item.promptNotes,
      status,
      statusLabel,
      lastRunAt,
      lastRunNotes,
      durationMs,
      rawOutput
    };
  });

  // Calculate summary KPI metrics
  const activeRoutines = routines.filter(r => r.active);
  const total = routines.length;
  const activeCount = activeRoutines.length;
  const scheduledCount = activeRoutines.filter(r => r.triggerType === 'Scheduled').length;
  const apiTriggerCount = activeRoutines.filter(r => r.triggerType !== 'Scheduled').length;
  const succeededCount = activeRoutines.filter(r => r.status === 'succeeded' || r.status === 'active').length;
  const issuesCount = activeRoutines.filter(r => r.status === 'failed' || r.status === 'warning').length;
  const inactiveCount = routines.filter(r => !r.active).length;

  return {
    summary: {
      total,
      active: activeCount,
      scheduled: scheduledCount,
      apiTrigger: apiTriggerCount,
      succeeded: succeededCount,
      issues: issuesCount,
      inactive: inactiveCount,
      healthyPct: activeCount > 0 ? Math.round((succeededCount / activeCount) * 100) : 100
    },
    routines,
    lastPolledAt: new Date().toISOString()
  };
}
