// ga4-click-to-call-sync — weekly monthly snapshot of GA4 "click_to_call" (phone-click) events.
//
// Pulls per-(yearMonth, sessionSourceMedium) `eventCount` for the GA4 events
// `click_to_call` / `Click to Call` from the GA4 Data API (`runReport` on property
// 363754280) using the service-account JWT, buckets each source/medium into a small
// fixed channel set (Google Ads / Bing Ads / Organic / Direct / Other), tags each month
// with its Australian financial year (Jul–Jun, END-year: FY27 = 2027), and UPSERTS one
// row per (year_month, channel) into `public.ga4_click_to_call_monthly` via
// `public.reload_ga4_click_to_call_monthly`.
//
// For every month with any click_to_call activity we emit ALL channels (0-filled) so a
// stored value always equals GA4's current figure — no stale channel rows can linger.
//
// UPSERT-ONLY / NEVER TRUNCATE: each run recomputes every month in place; prior rows are
// updated on (year_month, channel) conflict and never deleted or truncated.
//
// Invoke: ?dry=1 (preview, no write) · ?sync=1 (write inline) · bare (background 202).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), GA4_PROPERTY_ID,
//          GA4_SA_JSON_B64, plus optional GMAIL_USER / GMAIL_APP_PASSWORD / ALERT_EMAIL.
// Deploy: supabase functions deploy ga4-click-to-call-sync --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GA4_PROPERTY_ID = (Deno.env.get("GA4_PROPERTY_ID") ?? "363754280").trim();
const GA4_SA_JSON_B64 = (Deno.env.get("GA4_SA_JSON_B64") ?? "").trim();

const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
const ALERT_EMAIL = Deno.env.get("ALERT_EMAIL") ?? "julienne@myadventuregroup.com.au";

// Start of FY22 (Australian FY: 1 July 2021).
const START_DATE = "2021-07-01";
// GA4 event names that represent a phone-number click (current + legacy Title-Case variant).
const CLICK_TO_CALL_EVENTS = ["click_to_call", "Click to Call"];
// Fixed channel set — ALWAYS emitted (0-filled) for any month that has activity.
const CHANNELS = ["Google Ads", "Bing Ads", "Organic", "Direct", "Other"] as const;
type Channel = (typeof CHANNELS)[number];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });

// ---- GA4 service-account auth (JWT -> access token) -----------------------
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64url(data: ArrayBuffer | string): string {
  let bin: string;
  if (typeof data === "string") bin = data;
  else {
    const b = new Uint8Array(data);
    bin = "";
    for (const c of b) bin += String.fromCharCode(c);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function ga4AccessToken(sa: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  };
  const toSign = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(toSign));
  const jwt = `${toSign}.${b64url(sig)}`;
  const resp = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const j = await resp.json();
  if (!j.access_token) throw new Error(`GA4 token error: ${JSON.stringify(j)}`);
  return j.access_token as string;
}

async function ga4RunReport(token: string, body: unknown): Promise<any> {
  const r = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const j = await r.json();
  if (!r.ok) throw new Error(`GA4 runReport error (${r.status}): ${JSON.stringify(j)}`);
  return j;
}

function fyEndFromYearMonth(ym: string): number | null {
  if (!ym || ym.length !== 6) return null;
  const yr = parseInt(ym.slice(0, 4), 10);
  const mo = parseInt(ym.slice(4, 6), 10);
  if (!Number.isFinite(yr) || !Number.isFinite(mo)) return null;
  return yr + (mo >= 7 ? 1 : 0);
}

// Bucket a GA4 sessionSourceMedium ("source / medium") into one of CHANNELS.
function channelOf(sourceMedium: string): Channel {
  const sm = (sourceMedium || "").trim().toLowerCase();
  const [source, medium] = sm.split(" / ").map((s) => (s ?? "").trim());
  if (medium && medium.includes("cpc")) {
    if (source.startsWith("google")) return "Google Ads";
    if (source.startsWith("bing") || source.includes("microsoft")) return "Bing Ads";
    return "Other";
  }
  if (medium === "organic") return "Organic";
  if (source === "(direct)" || sm === "(direct) / (none)") return "Direct";
  return "Other";
}

type Row = { year_month: string; channel: Channel; fy_end: number; events: number };

type Summary = {
  fn: string;
  property_id: string;
  rows_built: number;
  upserted_rows: number;
  months: number;
  total_events: number;
  per_fy: Record<string, { total: number; channels: Record<string, number> }>;
  dry: boolean;
  duration_ms: number;
  ok: boolean;
  error: string | null;
};

async function sendFailureEmail(summary: Summary, detail: string): Promise<void> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error("[ga4-click-to-call-sync] alert email NOT sent — GMAIL_USER/GMAIL_APP_PASSWORD not set");
    return;
  }
  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD },
    },
  });
  try {
    await client.send({
      from: GMAIL_USER,
      to: ALERT_EMAIL,
      subject: "⚠️ ga4-click-to-call-sync FAILED",
      content: "auto",
      html: `<p>The <b>ga4-click-to-call-sync</b> edge function failed. The
        <code>ga4_click_to_call_monthly</code> table was <b>NOT</b> modified.</p>
        <p><b>Error:</b></p><pre>${detail.replace(/[<>&]/g, (c) =>
          ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string))}</pre>
        <p><b>Summary:</b></p><pre>${JSON.stringify(summary, null, 2)}</pre>
        <p>Ran at ${new Date().toISOString()}</p>`,
    });
  } finally {
    await client.close();
  }
}

async function run(dry: boolean): Promise<Summary> {
  const started = Date.now();
  const summary: Summary = {
    fn: "ga4-click-to-call-sync",
    property_id: GA4_PROPERTY_ID,
    rows_built: 0,
    upserted_rows: 0,
    months: 0,
    total_events: 0,
    per_fy: {},
    dry,
    duration_ms: 0,
    ok: false,
    error: null,
  };

  try {
    if (!GA4_PROPERTY_ID || !GA4_SA_JSON_B64) {
      throw new Error("Missing GA4_PROPERTY_ID or GA4_SA_JSON_B64 edge secret");
    }
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }

    const sa = JSON.parse(atob(GA4_SA_JSON_B64));
    const token = await ga4AccessToken(sa);

    const report = await ga4RunReport(token, {
      dateRanges: [{ startDate: START_DATE, endDate: "today" }],
      dimensions: [{ name: "yearMonth" }, { name: "sessionSourceMedium" }],
      metrics: [{ name: "eventCount" }],
      dimensionFilter: {
        filter: { fieldName: "eventName", inListFilter: { values: CLICK_TO_CALL_EVENTS } },
      },
      limit: 100000,
    });

    // month -> channel -> events (only channels that actually occur are summed here).
    const byMonth = new Map<string, Map<Channel, number>>();
    for (const r of (report.rows ?? [])) {
      const ym = r.dimensionValues?.[0]?.value ?? "";
      const sm = r.dimensionValues?.[1]?.value ?? "";
      const fyEnd = fyEndFromYearMonth(ym);
      if (!fyEnd) continue;
      const ev = parseInt(r.metricValues?.[0]?.value ?? "0", 10) || 0;
      if (ev <= 0) continue;
      const ch = channelOf(sm);
      let m = byMonth.get(ym);
      if (!m) { m = new Map(); byMonth.set(ym, m); }
      m.set(ch, (m.get(ch) ?? 0) + ev);
    }

    // Build 0-filled rows: every channel for every month that has activity.
    const rows: Row[] = [];
    for (const [ym, chMap] of [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const fyEnd = fyEndFromYearMonth(ym)!;
      for (const ch of CHANNELS) {
        rows.push({ year_month: ym, channel: ch, fy_end: fyEnd, events: chMap.get(ch) ?? 0 });
      }
    }

    const totalEvents = rows.reduce((a, r) => a + r.events, 0);
    if (rows.length === 0 || totalEvents === 0) {
      throw new Error("GA4 returned 0 click_to_call events — refusing to write empty snapshot");
    }

    summary.rows_built = rows.length;
    summary.months = byMonth.size;
    summary.total_events = totalEvents;
    for (const r of rows) {
      const fy = "FY" + String(r.fy_end - 2000).padStart(2, "0");
      const bucket = (summary.per_fy[fy] ??= { total: 0, channels: {} });
      bucket.total += r.events;
      if (r.events > 0) bucket.channels[r.channel] = (bucket.channels[r.channel] ?? 0) + r.events;
    }

    if (dry) {
      summary.ok = true;
      summary.duration_ms = Date.now() - started;
      console.log("[ga4-click-to-call-sync] DRY:", JSON.stringify(summary));
      return summary;
    }

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data, error } = await db.rpc("reload_ga4_click_to_call_monthly", { _rows: rows });
    if (error) throw new Error(`reload_ga4_click_to_call_monthly failed: ${error.message}`);
    summary.upserted_rows = typeof data === "number" ? data : rows.length;

    summary.ok = true;
    summary.duration_ms = Date.now() - started;
    console.log("[ga4-click-to-call-sync] done:", JSON.stringify(summary));
    return summary;
  } catch (err) {
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : String(err);
    summary.duration_ms = Date.now() - started;
    console.error("[ga4-click-to-call-sync] FAILED:", summary.error);
    if (!dry) {
      try {
        await sendFailureEmail(summary, summary.error);
      } catch (mailErr) {
        console.error("[ga4-click-to-call-sync] failed to send alert email:", mailErr);
      }
    }
    return summary;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const sync = url.searchParams.get("sync") === "1";
  if (dry || sync) {
    const res = await run(dry);
    return json(res, res.ok ? 200 : 500);
  }
  if (EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(run(false));
    return json(
      { message: "ga4-click-to-call-sync started in background", timestamp: new Date().toISOString() },
      202,
    );
  }
  const res = await run(false);
  return json(res, res.ok ? 200 : 500);
});
