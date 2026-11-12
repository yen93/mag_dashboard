// supabase/functions/monitoring-health-digest/index.ts
//
// Daily health monitoring digest that audits all active dashboard monitoring tabs:
// 1. DB Automations (Edge Functions & pg_cron jobs in MAG Supabase)
// 2. Claude Code Routines (Scheduled and on-demand cloud agents)
// 3. n8n Automations (Webhooks and workflows on n8n Cloud Run)
//
// Gathers execution telemetry, filters and highlights any errors and warnings,
// and delivers an email digest to the administrator every Monday–Friday at 6:30 AM PH time.
//
// Deploy command:
//   supabase functions deploy monitoring-health-digest --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

// Environment / Secrets
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUPABASE_ACCESS_TOKEN = Deno.env.get("SUPABASE_ACCESS_TOKEN") ?? "";

const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
const ALERT_EMAIL = Deno.env.get("ALERT_EMAIL") ?? "julienne@myadventuregroup.com.au";

const N8N_API_URL = (Deno.env.get("N8N_API_URL") ?? "https://n8n-659687081407.australia-southeast1.run.app").replace(/\/+$/, "");
const N8N_API_KEY = Deno.env.get("N8N_API_KEY") ?? "";

const MAG_PROJECT_ID = "aivitcomiywiysrfwqxt";
const N8N_PROJECT_ID = "uwsncuowtzydylfabikj";
const DASHBOARD_BASE_URL = "https://dashboard-659687081407.australia-southeast1.run.app";

// Parent workflow names mapping for readable reporting
const N8N_WORKFLOW_NAMES: Record<string, string> = {
  "R6VdvISsfVnq39Tr": "Insta Story Scraper",
  "cMQvsiTLhNoHK1Fm": "Sales Batch Mailer V2",
  "8vZG1SAYwSmcHJ2x": "AC Notes Automation",
  "JZkIKy3LsaLx0q5z": "Cold Leads Follow Up Sequence",
  "ww6XNc05nJlf54Vb": "Cold Leads Scraper",
  "d5NAgNp9XRLFIM0R": "LinkedIn Outbound Sales",
  "YAexztVMLu7zp3TN": "LinkedIn Comments Scraping",
  "HvLDCK6pfxYOgCWw": "LinkedIn Company Lead Finder",
  "gI2MaSOvuxrzJ4m4": "Soc Med Follow Up Sequence",
  "MveMnP6j7IIQ6UYM": "Closed Threads Processing",
  "lPgAcjCPUytZ4pph": "Sales Daily Email Notification",
  "ik1kyavpU8RrC8F3": "AC Caching"
};

interface HealthIssue {
  severity: "error" | "warning";
  tab: string;
  name: string;
  message: string;
  time: string | null;
  triage: string;
}

interface TabSummary {
  tabName: string;
  total: number;
  active: number;
  healthy: number;
  errors: number;
  warnings: number;
  url: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });

/**
 * Executes a read-only SQL query via the Supabase Management API.
 */
async function querySupabaseProject(projectId: string, sql: string): Promise<any[]> {
  if (!SUPABASE_ACCESS_TOKEN) return [];
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectId}/database/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query: sql })
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.error(`[monitoring-digest] Query to ${projectId} failed:`, err);
  }
  return [];
}

/**
 * 1. Audits DB Automations (Supabase Edge Functions & pg_cron jobs in MAG project)
 */
async function auditDbAutomations(): Promise<{ summary: TabSummary; issues: HealthIssue[] }> {
  const issues: HealthIssue[] = [];
  let total = 0;
  let active = 0;
  let errors = 0;
  let warnings = 0;

  try {
    const cronSql = `
      SELECT 
        j.jobid, j.jobname, j.schedule, j.active,
        d.status as last_status, d.return_message, d.start_time
      FROM cron.job j
      LEFT JOIN LATERAL (
        SELECT status, return_message, start_time
        FROM cron.job_run_details
        WHERE jobid = j.jobid
        ORDER BY start_time DESC
        LIMIT 1
      ) d ON true
      ORDER BY j.jobname;
    `;
    const cronJobs = await querySupabaseProject(MAG_PROJECT_ID, cronSql);
    total = cronJobs.length;
    active = cronJobs.filter((c: any) => c.active).length;

    for (const c of cronJobs) {
      if (c.active && c.last_status === "failed") {
        errors++;
        issues.push({
          severity: "error",
          tab: "DB Automations",
          name: c.jobname,
          message: `pg_cron execution failed: ${c.return_message || "Execution error"}`,
          time: c.start_time,
          triage: "Check function logs via Supabase CLI or management console."
        });
      }
    }

    // Check recent HTTP response errors in net._http_response (last 24 hours)
    const httpSql = `
      SELECT id, status_code, error_msg, timed_out, created
      FROM net._http_response
      WHERE (status_code >= 400 OR error_msg IS NOT NULL OR timed_out = true)
        AND created >= NOW() - INTERVAL '24 hours'
      ORDER BY id DESC LIMIT 5;
    `;
    const httpErrors = await querySupabaseProject(MAG_PROJECT_ID, httpSql);
    for (const h of httpErrors) {
      warnings++;
      const createdStr = String(h.created || "");
      let inferredJob = `HTTP Dispatch #${h.id}`;
      let triageMsg = "Ensure Edge Function has sufficient execution timeout or memory.";

      if (createdStr.includes(" 22:20:") || createdStr.includes("T22:20:")) {
        inferredJob = `sync-insta-stories (HTTP #${h.id})`;
        triageMsg = "pg_net reached 5000ms default timeout during cold start. Add timeout_milliseconds := 60000 in pg_cron command.";
      } else if (createdStr.includes(" 22:30:") || createdStr.includes("T22:30:")) {
        inferredJob = `analyze-insta-stories-daily (HTTP #${h.id})`;
        triageMsg = "pg_net reached 5000ms default timeout during cold start. Add timeout_milliseconds := 60000 in pg_cron command.";
      } else if (createdStr.includes(" 02:00:") || createdStr.includes("T02:00:")) {
        inferredJob = `renew-gmail-watch-daily (HTTP #${h.id})`;
        triageMsg = "pg_net reached 5000ms default timeout during cold start. Add timeout_milliseconds := 60000 in pg_cron command.";
      }

      issues.push({
        severity: "warning",
        tab: "DB Automations",
        name: inferredJob,
        message: h.timed_out
          ? "Cold-start timeout: pg_net reached default 5000ms threshold before function responded"
          : `HTTP error status ${h.status_code || "unknown"}: ${h.error_msg || "Bad response"}`,
        time: h.created,
        triage: triageMsg
      });
    }
  } catch (err) {
    console.error("[monitoring-digest] Error auditing DB automations:", err);
  }

  const healthy = Math.max(0, active - errors);
  return {
    summary: {
      tabName: "DB Automations",
      total,
      active,
      healthy,
      errors,
      warnings,
      url: `${DASHBOARD_BASE_URL}/builds_monitoring.html`
    },
    issues
  };
}

/**
 * 2. Audits Claude Code Routines (Freshness & Execution status)
 */
async function auditClaudeRoutines(): Promise<{ summary: TabSummary; issues: HealthIssue[] }> {
  const issues: HealthIssue[] = [];
  let errors = 0;
  let warnings = 0;

  try {
    // A. Email & Partners Sync (Weekly Mondays)
    const emailRes = await querySupabaseProject(
      MAG_PROJECT_ID,
      "SELECT max(captured_at) as last_captured FROM public.email_partner_metrics;"
    );
    const lastEmail = emailRes[0]?.last_captured ? new Date(emailRes[0].last_captured) : null;
    const emailAgeDays = lastEmail ? (Date.now() - lastEmail.getTime()) / (1000 * 3600 * 24) : 999;
    if (emailAgeDays > 8) {
      warnings++;
      issues.push({
        severity: "warning",
        tab: "Claude Code Routines",
        name: "Email & Partners Weekly Sync",
        message: `Stale metrics snapshot: Last recorded ${emailAgeDays.toFixed(1)} days ago`,
        time: emailRes[0]?.last_captured,
        triage: "Run email-partners-sync routine via Claude Code cloud runner."
      });
    }

    // B. Sales Topline Sync (Weekly Mondays)
    const salesRes = await querySupabaseProject(
      MAG_PROJECT_ID,
      "SELECT max(updated_at) as last_updated FROM public.sales_topline;"
    );
    const lastSales = salesRes[0]?.last_updated ? new Date(salesRes[0].last_updated) : null;
    const salesAgeDays = lastSales ? (Date.now() - lastSales.getTime()) / (1000 * 3600 * 24) : 999;
    if (salesAgeDays > 8) {
      warnings++;
      issues.push({
        severity: "warning",
        tab: "Claude Code Routines",
        name: "Sales Top-Line & Conference KPIs Sync",
        message: `Stale table metrics: Last updated ${salesAgeDays.toFixed(1)} days ago`,
        time: salesRes[0]?.last_updated,
        triage: "Run sales-topline-sync routine via Claude Code cloud runner."
      });
    }

    // C. Invoice Tracking Sync (Daily Mon-Fri)
    const invRes = await querySupabaseProject(
      MAG_PROJECT_ID,
      "SELECT max(updated_at) as last_updated FROM public.invoice_tracking;"
    );
    const lastInv = invRes[0]?.last_updated ? new Date(invRes[0].last_updated) : null;
    const invAgeDays = lastInv ? (Date.now() - lastInv.getTime()) / (1000 * 3600 * 24) : 999;
    // On weekdays, invoice tracking should be refreshed within 3 days
    if (invAgeDays > 3.5) {
      warnings++;
      issues.push({
        severity: "warning",
        tab: "Claude Code Routines",
        name: "Xero Invoice Tracking & AC Deal Matcher",
        message: `Stale invoice tracking: Last run ${invAgeDays.toFixed(1)} days ago`,
        time: invRes[0]?.last_updated,
        triage: "Check Xero MCP token and execute invoice-tracking-sync routine."
      });
    }

    // D. GA4 On-Demand Agent (Check failed or stuck requests)
    const ga4Res = await querySupabaseProject(
      MAG_PROJECT_ID,
      "SELECT id, status, prompt, error, created_at FROM public.ga4_agent_requests WHERE created_at >= NOW() - INTERVAL '24 hours' AND status IN ('error', 'pending');"
    );
    for (const g of ga4Res) {
      if (g.status === "error") {
        errors++;
        issues.push({
          severity: "error",
          tab: "Claude Code Routines",
          name: `GA4 Query #${g.id}`,
          message: `Worker execution error: ${g.error || "Execution failed"}`,
          time: g.created_at,
          triage: "Verify GA4 container credentials and routine endpoint."
        });
      } else if (g.status === "pending") {
        warnings++;
        issues.push({
          severity: "warning",
          tab: "Claude Code Routines",
          name: `GA4 Query #${g.id}`,
          message: "Request has remained pending for over 24 hours",
          time: g.created_at,
          triage: "Re-trigger on-demand worker via POST /api/ga4-agent/run."
        });
      }
    }
  } catch (err) {
    console.error("[monitoring-digest] Error auditing Claude routines:", err);
  }

  const healthy = Math.max(0, 4 - (errors + warnings));
  return {
    summary: {
      tabName: "Claude Code Routines",
      total: 4,
      active: 4,
      healthy,
      errors,
      warnings,
      url: `${DASHBOARD_BASE_URL}/claude_routines.html`
    },
    issues
  };
}

/**
 * 3. Audits n8n Automations (n8n API executions + Supabase pg_cron in uwsncuowtzydylfabikj)
 */
async function auditN8nAutomations(): Promise<{ summary: TabSummary; issues: HealthIssue[] }> {
  const issues: HealthIssue[] = [];
  let errors = 0;
  let warnings = 0;
  const total = 30;
  const active = 28;

  try {
    // A. Query n8n executions for failures in last 24 hours
    if (N8N_API_KEY) {
      const res = await fetch(`${N8N_API_URL}/api/v1/executions?limit=60`, {
        headers: { "X-N8N-API-KEY": N8N_API_KEY }
      });
      if (res.ok) {
        const json = await res.json();
        const execs = json.data || [];
        const yesterday = new Date(Date.now() - 24 * 3600 * 1000);

        const failed = execs.filter(
          (e: any) =>
            (e.status === "error" || e.status === "failed") &&
            new Date(e.startedAt) >= yesterday
        );

        for (const f of failed) {
          errors++;
          const wfTitle = N8N_WORKFLOW_NAMES[f.workflowId] || `Workflow ${f.workflowId}`;
          let specificError = "Execution terminated with error status on n8n Cloud Run runner";
          let failedNode = "";

          // Fetch full execution details to extract exact node and error message
          try {
            const detailRes = await fetch(`${N8N_API_URL}/api/v1/executions/${f.id}?includeData=true`, {
              headers: { "X-N8N-API-KEY": N8N_API_KEY }
            });
            if (detailRes.ok) {
              const detailJson = await detailRes.json();
              const errObj = detailJson.data?.resultData?.error;
              if (errObj) {
                specificError = errObj.message || specificError;
                failedNode = errObj.node?.name ? `Node: [${errObj.node.name}] ` : "";
              }
            }
          } catch {
            // fallback to generic message if execution details call fails
          }

          issues.push({
            severity: "error",
            tab: "n8n Automations",
            name: `${wfTitle} (Exec #${f.id})`,
            message: `${failedNode}${specificError}`,
            time: f.startedAt,
            triage: `Inspect execution graph on n8n UI at ${N8N_API_URL}/workflow/${f.workflowId}/executions/${f.id}`
          });
        }
      }
    }

    // B. Query Supabase pg_cron jobs in n8n-production
    const n8nCronSql = `
      SELECT 
        j.jobid, j.jobname, j.schedule, j.active,
        d.status as last_status, d.return_message, d.start_time
      FROM cron.job j
      LEFT JOIN LATERAL (
        SELECT status, return_message, start_time
        FROM cron.job_run_details
        WHERE jobid = j.jobid
        ORDER BY start_time DESC
        LIMIT 1
      ) d ON true
      ORDER BY j.jobname;
    `;
    const cronJobs = await querySupabaseProject(N8N_PROJECT_ID, n8nCronSql);
    for (const c of cronJobs) {
      if (c.active && c.last_status === "failed") {
        errors++;
        issues.push({
          severity: "error",
          tab: "n8n Automations",
          name: `pg_cron: ${c.jobname}`,
          message: `Scheduled webhook trigger failed: ${c.return_message || "Execution error"}`,
          time: c.start_time,
          triage: "Verify webhook path and ensure Cloud Run instance is reachable."
        });
      }
    }
  } catch (err) {
    console.error("[monitoring-digest] Error auditing n8n automations:", err);
  }

  const healthy = Math.max(0, active - errors);
  return {
    summary: {
      tabName: "n8n Automations",
      total,
      active,
      healthy,
      errors,
      warnings,
      url: `${DASHBOARD_BASE_URL}/n8n_automations.html`
    },
    issues
  };
}

/**
 * Builds the responsive HTML email template emphasizing issues and warnings.
 */
function buildEmailHtml(
  issues: HealthIssue[],
  summaries: TabSummary[],
  generatedAt: Date
): string {
  const hasErrors = issues.some((i) => i.severity === "error");
  const hasWarnings = issues.some((i) => i.severity === "warning");
  const totalIssues = issues.length;

  const manilaDateStr = generatedAt.toLocaleString("en-AU", {
    timeZone: "Asia/Manila",
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

  // Banner styling
  let bannerColor = "#10b981"; // green
  let bannerTitle = "All Systems Nominal — 0 Errors, 0 Warnings";
  let bannerSub = "All monitored cloud routines, edge functions, and n8n webhooks are executing as scheduled.";

  if (hasErrors) {
    bannerColor = "#ef4444"; // red
    bannerTitle = `⚠️ Attention Required — ${totalIssues} Issue${totalIssues > 1 ? "s" : ""} Highlighted`;
    bannerSub = "Errors or execution faults were detected during the morning audit that require investigation.";
  } else if (hasWarnings) {
    bannerColor = "#f59e0b"; // amber
    bannerTitle = `Notice — ${totalIssues} Warning${totalIssues > 1 ? "s" : ""} Flagged`;
    bannerSub = "Minor delays, timeouts, or stale sync windows were detected. Review details below.";
  }

  // Generate Issues Cards
  let issuesHtml = "";
  if (totalIssues > 0) {
    issuesHtml = `
      <div style="margin-bottom: 28px;">
        <h3 style="margin: 0 0 14px; font-size: 16px; color: #1e293b; text-transform: uppercase; letter-spacing: 0.5px;">
          Action Required: Issues &amp; Warnings
        </h3>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: separate; border-spacing: 0 10px;">
          ${issues
            .map((it) => {
              const isErr = it.severity === "error";
              const pillBg = isErr ? "#fee2e2" : "#fef3c7";
              const pillColor = isErr ? "#b91c1c" : "#b45309";
              const borderColor = isErr ? "#fca5a5" : "#fcd34d";

              return `
              <tr>
                <td style="background: #ffffff; border: 1px solid ${borderColor}; border-left: 5px solid ${isErr ? "#ef4444" : "#f59e0b"}; border-radius: 8px; padding: 14px 16px;">
                  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                    <div>
                      <span style="display: inline-block; background: ${pillBg}; color: ${pillColor}; font-weight: 700; font-size: 11px; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;">
                        ${it.severity.toUpperCase()}
                      </span>
                      <span style="color: #64748b; font-size: 12px; margin-left: 8px; font-weight: 600;">
                        ${it.tab}
                      </span>
                    </div>
                    <span style="font-size: 11px; color: #94a3b8; font-family: monospace;">
                      ${it.time ? new Date(it.time).toLocaleTimeString("en-AU", { timeZone: "Asia/Manila" }) + " PH" : ""}
                    </span>
                  </div>
                  <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">
                    ${it.name}
                  </div>
                  <div style="font-size: 12.5px; color: #334155; margin-bottom: 8px; line-height: 1.45;">
                    ${it.message}
                  </div>
                  <div style="font-size: 12px; color: #64748b; background: #f8fafc; padding: 6px 10px; border-radius: 4px; border: 1px solid #e2e8f0;">
                    <strong style="color: #475569;">Triage:</strong> ${it.triage}
                  </div>
                </td>
              </tr>
            `;
            })
            .join("")}
        </table>
      </div>
    `;
  }

  // Generate Tab Summaries Table
  const summaryRowsHtml = summaries
    .map((s) => {
      const hasTabIssues = s.errors > 0 || s.warnings > 0;
      const statusBadge = s.errors > 0
        ? `<span style="background:#fee2e2; color:#b91c1c; padding:3px 8px; border-radius:4px; font-weight:700; font-size:11px;">${s.errors} ERRORS</span>`
        : s.warnings > 0
        ? `<span style="background:#fef3c7; color:#b45309; padding:3px 8px; border-radius:4px; font-weight:700; font-size:11px;">${s.warnings} WARN</span>`
        : `<span style="background:#dcfce7; color:#15803d; padding:3px 8px; border-radius:4px; font-weight:700; font-size:11px;">NOMINAL</span>`;

      return `
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 12px 14px; font-weight: 600; color: #0f172a;">
            <a href="${s.url}" style="color: #2563eb; text-decoration: none;">${s.tabName} &rarr;</a>
          </td>
          <td style="padding: 12px 14px; text-align: center; color: #475569;">${s.active} / ${s.total}</td>
          <td style="padding: 12px 14px; text-align: center; color: #16a34a; font-weight: 700;">${s.healthy}</td>
          <td style="padding: 12px 14px; text-align: center;">${statusBadge}</td>
        </tr>
      `;
    })
    .join("");

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>MAG Metrics Daily Health Digest</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f1f5f9; padding: 24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 680px; background: #ffffff; border-radius: 12px; border: 1px solid #cbd5e1; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.06);">
            
            <!-- Header -->
            <tr>
              <td style="background: #0f172a; padding: 20px 28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td>
                      <div style="font-size: 11px; text-transform: uppercase; color: #94a3b8; font-weight: 700; letter-spacing: 1px;">
                        MAG Metrics System Telemetry
                      </div>
                      <div style="font-size: 20px; font-weight: 700; color: #ffffff; margin-top: 3px;">
                        Daily Monitoring Health Digest
                      </div>
                    </td>
                    <td align="right" style="color: #94a3b8; font-size: 12px;">
                      ${manilaDateStr}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Status Banner -->
            <tr>
              <td style="padding: 24px 28px 20px;">
                <div style="background: ${bannerColor}15; border-left: 5px solid ${bannerColor}; padding: 14px 18px; border-radius: 6px;">
                  <div style="font-size: 16px; font-weight: 700; color: ${bannerColor}; margin-bottom: 3px;">
                    ${bannerTitle}
                  </div>
                  <div style="font-size: 13px; color: #334155;">
                    ${bannerSub}
                  </div>
                </div>
              </td>
            </tr>

            <!-- Main Content Area -->
            <tr>
              <td style="padding: 0 28px 24px;">
                
                <!-- Highlighted Issues (if any) -->
                ${issuesHtml}

                <!-- Monitoring Tabs Summary Table -->
                <div style="margin-top: ${totalIssues > 0 ? "10px" : "14px"};">
                  <h3 style="margin: 0 0 12px; font-size: 15px; color: #1e293b; text-transform: uppercase; letter-spacing: 0.5px;">
                    Overview Across Monitoring Tabs
                  </h3>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; text-align: left;">
                    <thead>
                      <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.5px;">
                        <th style="padding: 10px 14px;">Monitoring Tab</th>
                        <th style="padding: 10px 14px; text-align: center;">Active / Total</th>
                        <th style="padding: 10px 14px; text-align: center;">Nominal</th>
                        <th style="padding: 10px 14px; text-align: center;">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${summaryRowsHtml}
                    </tbody>
                  </table>
                </div>

                <!-- Action Button -->
                <div style="margin-top: 26px; text-align: center;">
                  <a href="${DASHBOARD_BASE_URL}/builds_monitoring.html" style="display: inline-block; background: #2563eb; color: #ffffff; padding: 10px 22px; font-size: 13.5px; font-weight: 600; text-decoration: none; border-radius: 6px;">
                    Open AI &amp; Automation Dashboard &rarr;
                  </a>
                </div>

              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background: #f8fafc; padding: 16px 28px; border-top: 1px solid #e2e8f0; font-size: 11.5px; color: #64748b; text-align: center;">
                Delivered automatically via Supabase Edge Function <code>monitoring-health-digest</code> scheduled at 6:30 AM PH (Mon–Fri).
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

/**
 * Sends the compiled digest email via Gmail SMTP.
 */
async function sendDigestEmail(
  toEmail: string,
  issues: HealthIssue[],
  htmlContent: string
): Promise<void> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error("[monitoring-digest] Cannot send email — GMAIL_USER or GMAIL_APP_PASSWORD not set in secrets.");
    return;
  }

  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD }
    }
  });

  const errCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warning").length;

  let subject = "🟢 [Nominal] MAG Metrics Daily Monitoring Digest";
  if (errCount > 0) {
    subject = `🔴 [${errCount} ERROR${errCount > 1 ? "S" : ""}] MAG Metrics Daily Monitoring Digest`;
  } else if (warnCount > 0) {
    subject = `🟡 [${warnCount} WARNING${warnCount > 1 ? "S" : ""}] MAG Metrics Daily Monitoring Digest`;
  }

  try {
    await client.send({
      from: GMAIL_USER,
      to: toEmail,
      subject,
      content: "auto",
      html: htmlContent
    });
    console.log(`[monitoring-digest] Successfully dispatched health digest email to ${toEmail}`);
  } finally {
    await client.close();
  }
}

/**
 * Edge Function Request Handler
 */
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const toEmail = url.searchParams.get("to") || ALERT_EMAIL;

  console.log(`[monitoring-digest] Starting daily monitoring health digest audit (dry=${dry})...`);

  try {
    const [dbResult, claudeResult, n8nResult] = await Promise.all([
      auditDbAutomations(),
      auditClaudeRoutines(),
      auditN8nAutomations()
    ]);

    const allIssues = [...dbResult.issues, ...claudeResult.issues, ...n8nResult.issues];
    const allSummaries = [dbResult.summary, claudeResult.summary, n8nResult.summary];

    const generatedAt = new Date();
    const htmlEmail = buildEmailHtml(allIssues, allSummaries, generatedAt);

    if (!dry) {
      await sendDigestEmail(toEmail, allIssues, htmlEmail);
    } else {
      console.log("[monitoring-digest] Dry run mode enabled — skipped SMTP dispatch.");
    }

    return json({
      ok: true,
      generatedAt: generatedAt.toISOString(),
      recipient: toEmail,
      dryRun: dry,
      totalIssues: allIssues.length,
      errorsCount: allIssues.filter((i) => i.severity === "error").length,
      warningsCount: allIssues.filter((i) => i.severity === "warning").length,
      summaries: allSummaries,
      issues: allIssues
    });
  } catch (err: any) {
    console.error("[monitoring-digest] Fatal error running health audit:", err);
    return json({ ok: false, error: err.message || "Internal error" }, 500);
  }
});
