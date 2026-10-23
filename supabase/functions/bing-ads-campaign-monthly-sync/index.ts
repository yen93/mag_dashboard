// bing-ads-campaign-monthly-sync — refreshes public.bing_ads_campaign_monthly, the Bing
// (Microsoft Advertising) half of the ROAS page's All-in ad-spend basis (FY25+). Mirrors
// google-ads-campaign-monthly-sync: pull monthly campaign cost, UPSERT on (month, campaign_id).
// roas.js LEFT JOINs this table, so until it has rows Bing spend simply reads $0.
//
// Flow (Microsoft Advertising Reporting API v13, REST):
//   1) refresh an OAuth access token (Microsoft identity platform, refresh-token grant).
//   2) POST a CampaignPerformanceReportRequest (Aggregation=Monthly) to GenerateReport/Submit
//      → ReportRequestId.
//   3) POST GenerateReport/Poll until Status=Success → ReportDownloadUrl.
//   4) GET the URL (always a ZIP), unzip, parse the CSV, map each (campaign, month) row.
//   5) UPSERT on (month, campaign_id).
//
// MSA refresh-token rotation (important): a PERSONAL Microsoft account refresh token is
// single-use — each redemption invalidates the old token and returns a new one. So the token
// is NOT read only from the BING_ADS_REFRESH_TOKEN secret: it's kept in public.oauth_token_store
// (provider='bing_ads'). Each run reads the latest stored token (falling back to the secret as a
// one-time seed), mints an access token, and writes the rotated refresh token straight back. If a
// run ever locks out (bad stored token), re-mint a fresh refresh token, update the secret, and
// delete the oauth_token_store row — the next run re-seeds from the secret.
//
// Scheduled weekly, Monday 06:00 Philippine Time (Sunday 22:00 UTC) — aligned with the Google job
// (migration 20261023091000). Runs inline; the cron POSTs with no Authorization header, so the
// function MUST be deployed --no-verify-jwt.
//
// Secrets required (set in the Supabase dashboard; nothing passes through an AI client):
//   BING_ADS_CLIENT_ID        — the registered Azure app (client) id.
//   BING_ADS_CLIENT_SECRET    — the app's client secret (Value, not the Secret ID).
//   BING_ADS_REFRESH_TOKEN    — the SEED refresh token (used only until oauth_token_store fills).
//   BING_ADS_DEVELOPER_TOKEN  — the Microsoft Advertising developer token.
//   BING_ADS_ACCOUNT_ID       — the ad account id (CustomerAccountId).
//   BING_ADS_CUSTOMER_ID      — the manager/customer id (CustomerId).
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — injected automatically by Supabase.
// Optional:
//   BING_ADS_TENANT           — OAuth tenant (default "common").
//   BING_ADS_START_DATE       — earliest month to (re)load (default 2024-07-01, FY25 start).
//
// Deploy command (if using the CLI):
//   supabase functions deploy bing-ads-campaign-monthly-sync --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { unzipSync } from "https://esm.sh/fflate@0.8.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("BING_ADS_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("BING_ADS_CLIENT_SECRET") ?? "";
const SEED_REFRESH_TOKEN = Deno.env.get("BING_ADS_REFRESH_TOKEN") ?? "";
const DEVELOPER_TOKEN = Deno.env.get("BING_ADS_DEVELOPER_TOKEN") ?? "";
const ACCOUNT_ID = Deno.env.get("BING_ADS_ACCOUNT_ID") ?? "";
const CUSTOMER_ID = Deno.env.get("BING_ADS_CUSTOMER_ID") ?? "";
const TENANT = Deno.env.get("BING_ADS_TENANT") ?? "common";
const START_DATE = Deno.env.get("BING_ADS_START_DATE") ?? "2024-07-01";

const TOKEN_PROVIDER = "bing_ads";
const REPORT_BASE = "https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport";
const POLL_DEADLINE_MS = 115_000; // stay under the edge wall clock
const POLL_INTERVAL_MS = 5_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const numify = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : 0;
};

// ---- OAuth2 refresh-token grant (Microsoft identity platform) ------------------
// Returns the new access token AND the (possibly rotated) refresh token.
async function refreshAccessToken(refreshToken: string): Promise<{ access: string; refresh: string }> {
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "https://ads.microsoft.com/msads.manage offline_access",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OAuth token error ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return { access: data.access_token as string, refresh: (data.refresh_token as string) || refreshToken };
}

// ---- Microsoft Advertising Reporting (REST) ------------------------------------
function reportHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    DeveloperToken: DEVELOPER_TOKEN,
    CustomerAccountId: ACCOUNT_ID,
    CustomerId: CUSTOMER_ID,
    "Content-Type": "application/json",
  };
}

function buildReportRequest(endDate: string) {
  const [sy, sm, sd] = START_DATE.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  return {
    ReportRequest: {
      Type: "CampaignPerformanceReportRequest",
      ExcludeColumnHeaders: false,
      ExcludeReportFooter: true,
      ExcludeReportHeader: true,
      Format: "Csv",
      FormatVersion: "2.0",
      ReturnOnlyCompleteData: false,
      Aggregation: "Monthly",
      Columns: [
        "TimePeriod", "CampaignId", "CampaignName", "Impressions",
        "Clicks", "Spend", "Conversions", "Revenue", "AllConversions",
      ],
      Scope: { AccountIds: [Number(ACCOUNT_ID)] },
      Time: {
        CustomDateRangeStart: { Day: sd, Month: sm, Year: sy },
        CustomDateRangeEnd: { Day: ed, Month: em, Year: ey },
        ReportTimeZone: "CanberraMelbourneSydney",
      },
    },
  };
}

// Minimal RFC-4180 CSV parser (handles quoted fields with commas/quotes/newlines).
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* ignore */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c !== ""))
    .map((r) => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
      return o;
    });
}

// Submit → poll → download → parse. Returns raw per-(campaign,month) objects.
async function pullCampaignMonthly(token: string, endDate: string): Promise<any[]> {
  const headers = reportHeaders(token);

  const subRes = await fetch(`${REPORT_BASE}/Submit`, {
    method: "POST", headers, body: JSON.stringify(buildReportRequest(endDate)),
  });
  const subText = await subRes.text();
  if (!subRes.ok) throw new Error(`Submit ${subRes.status}: ${subText.slice(0, 800)}`);
  const reqId = (() => { try { return JSON.parse(subText).ReportRequestId; } catch { return ""; } })();
  if (!reqId) throw new Error(`Submit returned no ReportRequestId: ${subText.slice(0, 400)}`);

  let status: any = null;
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await fetch(`${REPORT_BASE}/Poll`, {
      method: "POST", headers, body: JSON.stringify({ ReportRequestId: reqId }),
    });
    const pollText = await pollRes.text();
    if (!pollRes.ok) throw new Error(`Poll ${pollRes.status}: ${pollText.slice(0, 800)}`);
    try { status = JSON.parse(pollText)?.ReportRequestStatus; } catch { status = null; }
    if (status?.Status === "Success") break;
    if (status?.Status === "Error") throw new Error(`Report generation failed (Status=Error), requestId ${reqId}`);
  }
  if (status?.Status !== "Success") {
    throw new Error(`Report still '${status?.Status ?? "Pending"}' after ${POLL_DEADLINE_MS / 1000}s — re-run to continue.`);
  }
  const downloadUrl: string = status.ReportDownloadUrl || "";
  if (!downloadUrl) return []; // Success with no rows = no spend in range

  const dlRes = await fetch(downloadUrl);
  if (!dlRes.ok) throw new Error(`Download ${dlRes.status}`);
  const buf = new Uint8Array(await dlRes.arrayBuffer());
  const files = unzipSync(buf);
  const name = Object.keys(files).find((n) => n.toLowerCase().endsWith(".csv"));
  if (!name) throw new Error(`No CSV in report zip (entries: ${Object.keys(files).join(", ") || "none"}).`);
  const csv = new TextDecoder().decode(files[name]);

  return parseCsv(csv).map((rec) => ({
    month: rec["TimePeriod"],
    campaignId: rec["CampaignId"],
    campaignName: rec["CampaignName"],
    impressions: numify(rec["Impressions"]),
    clicks: numify(rec["Clicks"]),
    spend: numify(rec["Spend"]),
    conversions: numify(rec["Conversions"]),
    revenue: numify(rec["Revenue"]),
    allConversions: numify(rec["AllConversions"]),
  }));
}

function toRow(r: any) {
  const m = String(r.month ?? "").replace(/\//g, "-").slice(0, 7); // 'YYYY-MM'
  return {
    month: `${m}-01`,
    account_id: ACCOUNT_ID || null,
    campaign_id: Number(r.campaignId),
    campaign_name: r.campaignName ?? null,
    channel_type: "SEARCH",
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    cost: Number(r.spend ?? 0),
    conversions: Number(r.conversions ?? 0),
    conversions_value: Number(r.revenue ?? 0),
    all_conversions: Number(r.allConversions ?? r.conversions ?? 0),
    currency: "AUD",
    updated_at: new Date().toISOString(),
  };
}

Deno.serve(async (_req: Request) => {
  try {
    const missing = [
      ["BING_ADS_CLIENT_ID", CLIENT_ID],
      ["BING_ADS_CLIENT_SECRET", CLIENT_SECRET],
      ["BING_ADS_DEVELOPER_TOKEN", DEVELOPER_TOKEN],
      ["BING_ADS_ACCOUNT_ID", ACCOUNT_ID],
      ["BING_ADS_CUSTOMER_ID", CUSTOMER_ID],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) return json({ ok: false, error: `Missing secrets: ${missing.join(", ")}` }, 500);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Prefer the rotated refresh token in the store; fall back to the seed secret.
    const { data: tokRow } = await supabase
      .from("oauth_token_store").select("refresh_token").eq("provider", TOKEN_PROVIDER).maybeSingle();
    const storedToken = (tokRow?.refresh_token as string) || "";
    const firstTry = storedToken || SEED_REFRESH_TOKEN;
    if (!firstTry) return json({ ok: false, error: "No refresh token: set BING_ADS_REFRESH_TOKEN or seed oauth_token_store." }, 500);

    // Mint an access token; if the stored token is dead but the seed differs, retry with the seed.
    let minted: { access: string; refresh: string };
    try {
      minted = await refreshAccessToken(firstTry);
    } catch (e) {
      if (storedToken && SEED_REFRESH_TOKEN && SEED_REFRESH_TOKEN !== storedToken) {
        minted = await refreshAccessToken(SEED_REFRESH_TOKEN);
      } else throw e;
    }

    // Persist the rotated refresh token immediately (MSA tokens are single-use).
    const { error: upErr } = await supabase
      .from("oauth_token_store")
      .upsert({ provider: TOKEN_PROVIDER, refresh_token: minted.refresh, updated_at: new Date().toISOString() }, { onConflict: "provider" });
    if (upErr) console.error("[bing-ads] failed to persist rotated refresh token:", upErr.message);

    const endDate = new Date().toISOString().slice(0, 10);
    const results = await pullCampaignMonthly(minted.access, endDate);

    const byKey = new Map<string, any>();
    for (const r of results) {
      const row = toRow(r);
      if (!row.campaign_id || !row.month.startsWith("20")) continue;
      byKey.set(`${row.month}|${row.campaign_id}`, row);
    }
    const rows = [...byKey.values()];
    if (!rows.length) return json({ ok: false, error: "Bing Ads returned no campaign rows.", since: START_DATE }, 502);

    const { error } = await supabase
      .from("bing_ads_campaign_monthly")
      .upsert(rows, { onConflict: "month,campaign_id" });
    if (error) throw new Error(`Supabase upsert error: ${error.message}`);

    const months = [...new Set(rows.map((r) => r.month))].sort();
    return json({
      ok: true,
      upserted: rows.length,
      distinct_months: months.length,
      first_month: months[0],
      last_month: months[months.length - 1],
      total_cost: Math.round(rows.reduce((a, r) => a + r.cost, 0)),
    });
  } catch (err) {
    console.error("[bing-ads-campaign-monthly-sync]", err);
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
