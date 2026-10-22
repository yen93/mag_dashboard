// bing-ads-campaign-monthly-sync — refreshes public.bing_ads_campaign_monthly, the Bing
// (Microsoft Advertising) half of the ROAS page's All-in ad-spend basis (FY25+). Mirrors
// google-ads-campaign-monthly-sync: pull monthly campaign cost, UPSERT on (month, campaign_id).
//
// ⚠ SCAFFOLD — needs Microsoft Advertising credentials + the Reporting call completed and
// tested before it will return data. Until then the ROAS page simply reads Bing spend as $0
// (roas.js LEFT JOINs this table). The OAuth token mint and the Supabase upsert below are
// complete; the report fetch (pullCampaignMonthly) is the part to finish — see its TODO.
//
// Microsoft Advertising auth = OAuth2 (Microsoft identity platform) refresh-token grant +
// a developer token. Reporting is the Reporting API (SOAP SubmitGenerateReport → poll →
// download CSV); there is no Google-style searchStream. Fill pullCampaignMonthly with that
// flow (or the account's preferred report), map each row with toRow(), and the rest works.
//
// Scheduled weekly, Monday 06:00 Philippine Time (Sunday 22:00 UTC) — align with the Google job.
//
// Secrets required (set in the Supabase dashboard; nothing passes through an AI client):
//   BING_ADS_CLIENT_ID        — the registered Azure app (client) id.
//   BING_ADS_CLIENT_SECRET    — the app's client secret.
//   BING_ADS_REFRESH_TOKEN    — a long-lived refresh token for a user with Ads access.
//   BING_ADS_DEVELOPER_TOKEN  — the Microsoft Advertising developer token.
//   BING_ADS_ACCOUNT_ID       — the Microsoft Advertising account id (CustomerAccountId).
//   BING_ADS_CUSTOMER_ID      — the Microsoft Advertising manager/customer id (CustomerId).
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — injected automatically by Supabase.
// Optional:
//   BING_ADS_TENANT           — OAuth tenant (default "common").
//   BING_ADS_START_DATE       — earliest month to (re)load (default 2024-07-01).
//
// Deploy command:
//   supabase functions deploy bing-ads-campaign-monthly-sync --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("BING_ADS_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("BING_ADS_CLIENT_SECRET") ?? "";
const REFRESH_TOKEN = Deno.env.get("BING_ADS_REFRESH_TOKEN") ?? "";
const DEVELOPER_TOKEN = Deno.env.get("BING_ADS_DEVELOPER_TOKEN") ?? "";
const ACCOUNT_ID = Deno.env.get("BING_ADS_ACCOUNT_ID") ?? "";
const CUSTOMER_ID = Deno.env.get("BING_ADS_CUSTOMER_ID") ?? "";
const TENANT = Deno.env.get("BING_ADS_TENANT") ?? "common";
const START_DATE = Deno.env.get("BING_ADS_START_DATE") ?? "2024-07-01";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });

// ---- OAuth2 refresh-token grant (Microsoft identity platform) ----------------
async function getAccessToken(): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      scope: "https://ads.microsoft.com/msads.manage offline_access",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OAuth token error ${res.status}: ${JSON.stringify(data)}`);
  return data.access_token as string;
}

// ---- Microsoft Advertising Reporting --------------------------------------------
// TODO: implement the Reporting API flow and return one object per (campaign, month):
//   { month:'YYYY-MM', campaignId, campaignName, impressions, clicks, spend, conversions }
// Typical flow (Reporting API v13):
//   1) POST a CampaignPerformanceReportRequest (Aggregation=Monthly, Columns incl.
//      TimePeriod, CampaignId, CampaignName, Spend, Impressions, Clicks, Conversions,
//      time range START_DATE..today) to SubmitGenerateReport.
//   2) Poll PollGenerateReport until Success; download the report (CSV/zip) URL.
//   3) Parse the CSV rows.
// Headers required on each call: Authorization: Bearer <token>, DeveloperToken,
// CustomerAccountId: ACCOUNT_ID, CustomerId: CUSTOMER_ID.
async function pullCampaignMonthly(_token: string, _endDate: string): Promise<any[]> {
  throw new Error(
    "pullCampaignMonthly not implemented — complete the Microsoft Advertising Reporting " +
    "API flow (see the TODO in this file).",
  );
}

function toRow(r: any) {
  const m = String(r.month ?? "").slice(0, 7); // 'YYYY-MM'
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
      ["BING_ADS_REFRESH_TOKEN", REFRESH_TOKEN],
      ["BING_ADS_DEVELOPER_TOKEN", DEVELOPER_TOKEN],
      ["BING_ADS_ACCOUNT_ID", ACCOUNT_ID],
      ["BING_ADS_CUSTOMER_ID", CUSTOMER_ID],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return json({ ok: false, error: `Missing secrets: ${missing.join(", ")}` }, 500);
    }

    const token = await getAccessToken();
    const endDate = new Date().toISOString().slice(0, 10);
    const results = await pullCampaignMonthly(token, endDate);

    const byKey = new Map<string, any>();
    for (const r of results) {
      const row = toRow(r);
      if (!row.campaign_id || !row.month.startsWith("20")) continue;
      byKey.set(`${row.month}|${row.campaign_id}`, row);
    }
    const rows = [...byKey.values()];
    if (!rows.length) return json({ ok: false, error: "Bing Ads returned no campaign rows.", since: START_DATE }, 502);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
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
