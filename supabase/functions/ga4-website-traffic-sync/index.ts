// ga4-website-traffic-sync — weekly snapshot of GA4 Website Sessions and Visits from AI tools.
//
// Pulls per-month `sessions` and per-(month, sessionSource) `sessions` from the
// GA4 Data API (`runReport` on property 363754280) using the service-account JWT,
// aggregates them into Australian financial years (Jul–Jun, END-year: FY27 = 2027),
// and UPSERTS one row per `(fy_end, snapshot_date)` into
// `public.ga4_website_traffic_snapshots` via `public.reload_ga4_website_traffic_snapshots`.
//
// UPSERT-ONLY / NEVER TRUNCATE:
//   Each weekly run inserts a fresh set of `(fy_end, snapshot_date)` rows for
//   today's date (or updates today's rows if re-run on the same day). Prior
//   snapshots are never truncated or deleted.
//
// Invoke: ?dry=1 (preview, no write) · ?sync=1 (write inline) · bare (background 202).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), GA4_PROPERTY_ID,
//          GA4_SA_JSON_B64, plus optional GMAIL_USER / GMAIL_APP_PASSWORD / ALERT_EMAIL.
// Deploy: supabase functions deploy ga4-website-traffic-sync --no-verify-jwt

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
const MIN_FY_END = 2022;

// Matches AI assistant referral/traffic sources in GA4 `sessionSource`.
// FALLBACK ONLY: the live, maintained list lives in public.ai_source_patterns
// (appended monthly by ai-source-patterns-sync). This regex is used only if that
// table is empty or unreachable, so the classification never silently breaks.
const AI_SOURCE_RE =
  /(chatgpt|openai|perplexity|claude\.ai|anthropic|gemini\.google|bard\.google|copilot|edgeservices|poe\.com|you\.com|phind|mistral|deepseek|meta\.ai|grok)/i;

// Load the maintained AI-source substrings from public.ai_source_patterns (active only).
// Returns [] on any failure, which makes callers fall back to AI_SOURCE_RE.
async function loadAiPatterns(db: any): Promise<string[]> {
  try {
    const { data, error } = await db.from("ai_source_patterns").select("pattern").eq("active", true);
    if (error) throw error;
    return (data ?? [])
      .map((r: any) => String(r.pattern ?? "").trim().toLowerCase())
      .filter((p: string) => p.length > 0);
  } catch (e) {
    console.error(
      "[ga4-website-traffic-sync] ai_source_patterns load failed; using fallback AI_SOURCE_RE:",
      e instanceof Error ? e.message : String(e),
    );
    return [];
  }
}

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

// ---- GA4 Data API: runReport ----------------------------------------------
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

function currentAuFyEnd(now = new Date()): number {
  const yr = now.getUTCFullYear();
  const mo = now.getUTCMonth() + 1;
  return yr + (mo >= 7 ? 1 : 0);
}

type SnapshotRow = {
  fy_end: number;
  fy_label: string;
  snapshot_date: string;
  website_sessions: number;
  ai_tool_visits: number;
  ai_sources_breakdown: Record<string, number>;
};

type Summary = {
  fn: string;
  snapshot_date: string;
  property_id: string;
  ai_matcher: string;
  rows_built: number;
  upserted_rows: number;
  per_fy: Record<string, { website_sessions: number; ai_tool_visits: number; ai_sources: Record<string, number> }>;
  dry: boolean;
  duration_ms: number;
  ok: boolean;
  error: string | null;
};

async function sendFailureEmail(summary: Summary, detail: string): Promise<void> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error("[ga4-website-traffic-sync] alert email NOT sent — GMAIL_USER/GMAIL_APP_PASSWORD not set");
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
      subject: "⚠️ ga4-website-traffic-sync FAILED",
      content: "auto",
      html: `<p>The <b>ga4-website-traffic-sync</b> edge function failed. The
        <code>ga4_website_traffic_snapshots</code> table was <b>NOT</b> modified.</p>
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
  const snapshot = new Date().toISOString().slice(0, 10);
  const summary: Summary = {
    fn: "ga4-website-traffic-sync",
    snapshot_date: snapshot,
    property_id: GA4_PROPERTY_ID,
    ai_matcher: "",
    rows_built: 0,
    upserted_rows: 0,
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

    // One Supabase client for both reading the AI-source list and the later upsert.
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // Maintained AI-source substrings (public.ai_source_patterns); empty => fallback regex.
    const aiPatterns = await loadAiPatterns(db);
    summary.ai_matcher = aiPatterns.length
      ? `ai_source_patterns (${aiPatterns.length} active)`
      : "fallback AI_SOURCE_RE";
    const isAiSource = (src: string): boolean =>
      aiPatterns.length > 0 ? aiPatterns.some((p) => src.includes(p)) : AI_SOURCE_RE.test(src);

    // Run both reports in parallel:
    // 1. Total website sessions by yearMonth (no source dimension, avoiding any cardinality thresholding)
    // 2. Sessions by yearMonth + sessionSource to sum AI-assistant referral visits
    const [totalsReport, sourcesReport] = await Promise.all([
      ga4RunReport(token, {
        dateRanges: [{ startDate: START_DATE, endDate: "today" }],
        dimensions: [{ name: "yearMonth" }],
        metrics: [{ name: "sessions" }],
        orderBys: [{ dimension: { dimensionName: "yearMonth" } }],
        limit: 10000,
      }),
      ga4RunReport(token, {
        dateRanges: [{ startDate: START_DATE, endDate: "today" }],
        dimensions: [{ name: "yearMonth" }, { name: "sessionSource" }],
        metrics: [{ name: "sessions" }],
        limit: 100000,
      }),
    ]);

    const maxFyEnd = Math.max(currentAuFyEnd(), 2027);
    const byFy = new Map<number, SnapshotRow>();
    const ensureFy = (fyEnd: number): SnapshotRow => {
      let row = byFy.get(fyEnd);
      if (!row) {
        const fyLabel = "FY" + String(fyEnd - 2000).padStart(2, "0");
        row = {
          fy_end: fyEnd,
          fy_label: fyLabel,
          snapshot_date: snapshot,
          website_sessions: 0,
          ai_tool_visits: 0,
          ai_sources_breakdown: {},
        };
        byFy.set(fyEnd, row);
      }
      return row;
    };

    for (let fy = MIN_FY_END; fy <= maxFyEnd; fy++) ensureFy(fy);

    // 1. Populate total website_sessions per FY
    for (const r of (totalsReport.rows ?? [])) {
      const ym = r.dimensionValues?.[0]?.value ?? "";
      const fyEnd = fyEndFromYearMonth(ym);
      if (!fyEnd || fyEnd < MIN_FY_END) continue;
      const s = parseInt(r.metricValues?.[0]?.value ?? "0", 10) || 0;
      ensureFy(fyEnd).website_sessions += s;
    }

    // 2. Populate ai_tool_visits + per-source breakdown per FY
    for (const r of (sourcesReport.rows ?? [])) {
      const ym = r.dimensionValues?.[0]?.value ?? "";
      const src = (r.dimensionValues?.[1]?.value ?? "").trim().toLowerCase();
      const fyEnd = fyEndFromYearMonth(ym);
      if (!fyEnd || fyEnd < MIN_FY_END || !src) continue;
      if (!isAiSource(src)) continue;
      const s = parseInt(r.metricValues?.[0]?.value ?? "0", 10) || 0;
      if (s <= 0) continue;
      const rec = ensureFy(fyEnd);
      rec.ai_tool_visits += s;
      rec.ai_sources_breakdown[src] = (rec.ai_sources_breakdown[src] ?? 0) + s;
    }

    const rows = [...byFy.values()].sort((a, b) => a.fy_end - b.fy_end);
    const totalSessions = rows.reduce((acc, r) => acc + r.website_sessions, 0);
    if (rows.length === 0 || totalSessions === 0) {
      throw new Error("GA4 returned 0 total website sessions — refusing to write empty snapshot");
    }

    summary.rows_built = rows.length;
    for (const r of rows) {
      summary.per_fy[r.fy_label] = {
        website_sessions: r.website_sessions,
        ai_tool_visits: r.ai_tool_visits,
        ai_sources: r.ai_sources_breakdown,
      };
    }

    if (dry) {
      summary.ok = true;
      summary.duration_ms = Date.now() - started;
      console.log("[ga4-website-traffic-sync] DRY:", JSON.stringify(summary));
      return summary;
    }

    const { data, error } = await db.rpc("reload_ga4_website_traffic_snapshots", { _rows: rows });
    if (error) throw new Error(`reload_ga4_website_traffic_snapshots failed: ${error.message}`);
    summary.upserted_rows = typeof data === "number" ? data : rows.length;

    summary.ok = true;
    summary.duration_ms = Date.now() - started;
    console.log("[ga4-website-traffic-sync] done:", JSON.stringify(summary));
    return summary;
  } catch (err) {
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : String(err);
    summary.duration_ms = Date.now() - started;
    console.error("[ga4-website-traffic-sync] FAILED:", summary.error);
    if (!dry) {
      try {
        await sendFailureEmail(summary, summary.error);
      } catch (mailErr) {
        console.error("[ga4-website-traffic-sync] failed to send alert email:", mailErr);
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
      { message: "ga4-website-traffic-sync started in background", timestamp: new Date().toISOString() },
      202,
    );
  }
  const res = await run(false);
  return json(res, res.ok ? 200 : 500);
});
