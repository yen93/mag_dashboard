// google-ads-campaign-monthly-sync — refreshes public.google_ads_campaign_monthly,
// the ad-spend denominator behind the dashboard ROAS tab (server/metrics/roas.js).
//
// Auth: the Google Ads account 402-451-5888 is accessed by a SERVICE ACCOUNT
// (insta-drive-uploader@claudegwscli-502400) that was added as a Read-only user
// directly in Google Ads — no manager/MCC, no login-customer-id. This function mints
// an OAuth access token from that SA key (JWT bearer grant, scope .../auth/adwords)
// and calls the Google Ads REST searchStream endpoint. The developer token was sunset
// in Sept 2026, so none is sent. It pulls monthly campaign metrics since START_DATE
// and UPSERTs them on (month, campaign_id).
//
// Scheduled weekly, Monday 06:00 Philippine Time (Sunday 22:00 UTC).
//
// Invoke: GET/POST (runs inline, returns a summary). Quick (~a few seconds).
//
// Secrets required (set in the Supabase dashboard — the SA key never passes through
// an AI client):
//   GOOGLE_ADS_SA_KEY         — the FULL service-account JSON key (one line is fine).
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — injected automatically by Supabase.
// Optional overrides:
//   GOOGLE_ADS_CUSTOMER_ID    — default 4024515888 (402-451-5888, digits only).
//   GOOGLE_ADS_API_VERSION    — default v26 (bump when Google sunsets a version).
//   GOOGLE_ADS_START_DATE     — default 2024-07-01 (earliest month to (re)load).
//
// Deploy command:
//   supabase functions deploy google-ads-campaign-monthly-sync --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SA_KEY_RAW = Deno.env.get("GOOGLE_ADS_SA_KEY") ?? "";
const CUSTOMER_ID = (Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") ?? "4024515888").replace(/\D/g, "");
const API_VERSION = Deno.env.get("GOOGLE_ADS_API_VERSION") ?? "v26";
const START_DATE = Deno.env.get("GOOGLE_ADS_START_DATE") ?? "2024-07-01";
const ACCOUNT_ID = "402-451-5888";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });

// ---- Service-account OAuth (JWT bearer grant) ------------------------------
function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getAccessToken(sa: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/adwords",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const input = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  const jwt = `${input}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OAuth token error ${res.status}: ${JSON.stringify(data)}`);
  return data.access_token as string;
}

// ---- Google Ads REST searchStream ------------------------------------------
async function pullCampaignMonthly(token: string, endDate: string): Promise<any[]> {
  const query =
    `SELECT campaign.id, campaign.name, campaign.advertising_channel_type, ` +
    `segments.month, metrics.impressions, metrics.clicks, metrics.cost_micros, ` +
    `metrics.conversions, metrics.conversions_value, metrics.all_conversions ` +
    `FROM campaign WHERE segments.date BETWEEN '${START_DATE}' AND '${endDate}'`;
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${CUSTOMER_ID}/googleAds:searchStream`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Ads API ${res.status}: ${text.slice(0, 800)}`);
  // searchStream returns an array of batches: [{ results: [...] }, ...]
  const batches = JSON.parse(text);
  const out: any[] = [];
  for (const batch of Array.isArray(batches) ? batches : [batches]) {
    for (const r of batch.results ?? []) out.push(r);
  }
  return out;
}

function toRow(r: any) {
  const m = String(r.segments?.month ?? "").slice(0, 7); // 'YYYY-MM'
  const metrics = r.metrics ?? {};
  return {
    month: `${m}-01`,
    account_id: ACCOUNT_ID,
    campaign_id: Number(r.campaign?.id),
    campaign_name: r.campaign?.name ?? null,
    channel_type: r.campaign?.advertisingChannelType ?? null,
    impressions: Number(metrics.impressions ?? 0),
    clicks: Number(metrics.clicks ?? 0),
    cost: Number(metrics.costMicros ?? 0) / 1_000_000,
    conversions: Number(metrics.conversions ?? 0),
    conversions_value: Number(metrics.conversionsValue ?? 0),
    all_conversions: Number(metrics.allConversions ?? 0),
    currency: "AUD",
    updated_at: new Date().toISOString(),
  };
}

Deno.serve(async (_req: Request) => {
  try {
    if (!SA_KEY_RAW) {
      return json({ ok: false, error: "GOOGLE_ADS_SA_KEY secret is not set." }, 500);
    }
    let sa: { client_email: string; private_key: string };
    try {
      sa = JSON.parse(SA_KEY_RAW);
    } catch {
      return json({ ok: false, error: "GOOGLE_ADS_SA_KEY is not valid JSON." }, 500);
    }

    const token = await getAccessToken(sa);
    const endDate = new Date().toISOString().slice(0, 10);
    const results = await pullCampaignMonthly(token, endDate);

    // Dedupe on (month, campaign_id) in case the API returns split rows.
    const byKey = new Map<string, any>();
    for (const r of results) {
      const row = toRow(r);
      if (!row.campaign_id || !row.month.startsWith("20")) continue;
      byKey.set(`${row.month}|${row.campaign_id}`, row);
    }
    const rows = [...byKey.values()];

    if (!rows.length) {
      return json({ ok: false, error: "Google Ads returned no campaign rows.", customer_id: CUSTOMER_ID, since: START_DATE }, 502);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { error } = await supabase
      .from("google_ads_campaign_monthly")
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
    console.error("[google-ads-campaign-monthly-sync]", err);
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
