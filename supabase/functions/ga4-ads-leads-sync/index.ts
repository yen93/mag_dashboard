// ga4-ads-leads-sync — refreshes the "GA4 & Ads Leads Tracking" tab.
//
// Each run (Mon-Fri 06:00 PH via pg_cron, '0 22 * * 0-4' UTC) it:
//   1. Pulls the last 60 days of GA4 form events + calendly_form_submit events
//      (GA4 Data API, service-account auth) — GA4 keeps per-minute data ~60 days.
//   2. Pulls the last 60 days of Calendly bookings (email + utm).
//   3. Loads them into the three staging tables and calls the Postgres RPC
//      rebuild_ga4_ac_matches(), which rebuilds public.ga4_ac_event_matches and
//      public.ga4_ac_contact_source (matched-only, with channel) — the two tables
//      the tab reads. Deal / CPC / Source Type columns join live from other tables.
//
// This is the server-side port of the google_ads_leads_tracking pipeline
// (scripts/map_ga4_ac.py + match_ga4_ac.sql), so the dashboard stays fresh with no
// manual runs. Mirrors the new-paid-leads-sync / sales-deals-sync edge-function pattern.
//
// Invoke: GET/POST (bare = async real run). ?sync=1 runs inline and returns the summary.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), GA4_PROPERTY_ID,
//          GA4_SA_JSON_B64 (base64 of the service-account JSON), CALENDLY_PAT.
// Deploy: Supabase MCP deploy_edge_function, verify_jwt:false.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GA4_PROPERTY_ID = (Deno.env.get("GA4_PROPERTY_ID") ?? "").trim();
const GA4_SA_JSON_B64 = (Deno.env.get("GA4_SA_JSON_B64") ?? "").trim();
const CALENDLY_PAT = (Deno.env.get("CALENDLY_PAT") ?? "").trim();

const WINDOW_DAYS = 60;
const TOL_SECONDS = 300;
// GA4 events treated as "form submits" (Calendly-specific events are handled
// separately, to derive the Calendly channel — not double-counted as form matches).
const FORM_EVENTS = [
  "form_submit", "form_submissions", "Contact_Form_Submit_Alt",
  "Form_submission_thankyou_1", "subscribe", "free_gifts_opt_ins",
];
const CALENDLY_EVENT = "calendly_form_submit";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

// ---- GA4 service-account auth (JWT -> access token) -----------------------
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function b64url(data: ArrayBuffer | string): string {
  let bin: string;
  if (typeof data === "string") bin = data;
  else { const b = new Uint8Array(data); bin = ""; for (const c of b) bin += String.fromCharCode(c); }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function ga4AccessToken(sa: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: sa.token_uri, iat: now, exp: now + 3600,
  };
  const toSign = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(toSign));
  const jwt = `${toSign}.${b64url(sig)}`;
  const resp = await fetch(sa.token_uri, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const j = await resp.json();
  if (!j.access_token) throw new Error(`GA4 token error: ${JSON.stringify(j)}`);
  return j.access_token as string;
}

// ---- timezone: GA4 dateHourMinute is property-local; convert wall time -> UTC ----
function tzOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - instant.getTime();
}
function wallToUtcIso(y: number, mo: number, d: number, h: number, mi: number, tz: string): string {
  const base = Date.UTC(y, mo - 1, d, h, mi, 0);
  let result = base - tzOffsetMs(new Date(base), tz);
  result = base - tzOffsetMs(new Date(result), tz); // settle DST boundaries
  return new Date(result).toISOString();
}

// ---- GA4 Data API: runReport ---------------------------------------------
interface Ga4Row { event_time_utc: string; event_name: string; source: string; medium: string; campaign: string; event_count: number; }
async function ga4Events(token: string): Promise<Ga4Row[]> {
  const body = {
    dateRanges: [{ startDate: `${WINDOW_DAYS}daysAgo`, endDate: "today" }],
    dimensions: [
      { name: "dateHourMinute" }, { name: "eventName" }, { name: "sessionSource" },
      { name: "sessionMedium" }, { name: "sessionCampaignName" },
    ],
    metrics: [{ name: "eventCount" }],
    dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: [...FORM_EVENTS, CALENDLY_EVENT] } } },
    limit: 100000,
  };
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`GA4 runReport error: ${JSON.stringify(j)}`);
  const tz = j.metadata?.timeZone ?? "UTC";
  const out: Ga4Row[] = [];
  for (const row of (j.rows ?? [])) {
    const dv = row.dimensionValues, dhm = dv[0].value as string;
    const y = +dhm.slice(0, 4), mo = +dhm.slice(4, 6), d = +dhm.slice(6, 8), h = +dhm.slice(8, 10), mi = +dhm.slice(10, 12);
    out.push({
      event_time_utc: wallToUtcIso(y, mo, d, h, mi, tz),
      event_name: dv[1].value, source: dv[2].value, medium: dv[3].value, campaign: dv[4].value,
      event_count: parseInt(row.metricValues[0].value, 10) || 0,
    });
  }
  return out;
}

// ---- Calendly API --------------------------------------------------------
const calHeaders = { Authorization: `Bearer ${CALENDLY_PAT}`, "Content-Type": "application/json" };
async function calGet(url: string): Promise<any | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, { headers: calHeaders });
      if (r.status === 429) { await sleep(2000); continue; }
      if (!r.ok) { console.warn(`Calendly ${r.status} for ${url}`); return null; }
      return await r.json();
    } catch (err) { console.warn(`Calendly fetch failed: ${err}`); await sleep(1000); }
  }
  return null;
}
interface Booking { email: string; booking_created_at: string | null; start_time: string | null; utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; event_name: string | null; }
async function calendlyBookings(days: number): Promise<Booking[]> {
  const me = await calGet("https://api.calendly.com/users/me");
  const user = me?.resource?.uri, org = me?.resource?.current_organization;
  if (!org) return [];
  const now = Date.now(), cutoffMs = now - days * 86400_000;
  const minStart = new Date(now - (days + 30) * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const maxStart = new Date(now + 366 * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const out: Booking[] = [];
  let url: string | null = "https://api.calendly.com/scheduled_events?" + new URLSearchParams({
    user, organization: org, status: "active", count: "100", sort: "start_time:desc",
    min_start_time: minStart, max_start_time: maxStart,
  }).toString();
  while (url) {
    const data: any = await calGet(url);
    if (!data) break;
    for (const ev of (data.collection ?? [])) {
      let invUrl: string | null = `${ev.uri}/invitees?` + new URLSearchParams({ count: "100", status: "active" }).toString();
      while (invUrl) {
        const inv: any = await calGet(invUrl);
        if (!inv) break;
        for (const i of (inv.collection ?? [])) {
          const created = i.created_at ?? ev.created_at ?? null;
          const cms = created ? Date.parse(created) : NaN;
          if (Number.isFinite(cms) && cms < cutoffMs) continue;
          const t = i.tracking ?? {};
          out.push({
            email: (i.email ?? "").trim().toLowerCase(),
            booking_created_at: created, start_time: ev.start_time ?? null,
            utm_source: t.utm_source ?? null, utm_medium: t.utm_medium ?? null,
            utm_campaign: t.utm_campaign ?? null, event_name: ev.name ?? null,
          });
        }
        invUrl = inv.pagination?.next_page ?? null;
        if (invUrl) await sleep(200);
      }
      await sleep(150);
    }
    url = data.pagination?.next_page ?? null;
  }
  return out.filter((b) => b.email);
}

// ---- staging load helper --------------------------------------------------
async function insertChunked(db: any, table: string, rows: any[], errors: string[]) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db.from(table).insert(rows.slice(i, i + CHUNK));
    if (error) errors.push(`${table} insert @${i}: ${error.message}`);
  }
}

type Summary = {
  fn: string; ran_at: string; ga4_form_rows: number; ga4_calendly_rows: number;
  calendly_bookings: number; rebuild: unknown; errors: string[];
};

async function run(): Promise<Summary> {
  const s: Summary = {
    fn: "ga4-ads-leads-sync", ran_at: new Date().toISOString(),
    ga4_form_rows: 0, ga4_calendly_rows: 0, calendly_bookings: 0, rebuild: null, errors: [],
  };
  if (!GA4_PROPERTY_ID || !GA4_SA_JSON_B64) s.errors.push("missing GA4_PROPERTY_ID / GA4_SA_JSON_B64");
  if (!CALENDLY_PAT) s.errors.push("missing CALENDLY_PAT");
  if (s.errors.length) return s;

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // 1. GA4 (form + calendly events) in one report, then split by event name.
  const sa = JSON.parse(atob(GA4_SA_JSON_B64));
  const token = await ga4AccessToken(sa);
  const ga4 = await ga4Events(token);
  const formRows = ga4.filter((r) => r.event_name !== CALENDLY_EVENT);
  const calEventRows = ga4.filter((r) => r.event_name === CALENDLY_EVENT)
    .map((r) => ({ event_time_utc: r.event_time_utc, source: r.source, medium: r.medium, campaign: r.campaign, event_count: r.event_count }));
  s.ga4_form_rows = formRows.length;
  s.ga4_calendly_rows = calEventRows.length;

  // 2. Calendly bookings.
  const bookings = await calendlyBookings(WINDOW_DAYS);
  s.calendly_bookings = bookings.length;

  // 3. Load staging (clear first) and rebuild the tab's tables.
  const { error: clrErr } = await db.rpc("clear_ga4_staging");
  if (clrErr) { s.errors.push(`clear_ga4_staging: ${clrErr.message}`); return s; }
  await insertChunked(db, "ga4_events_staging", formRows, s.errors);
  await insertChunked(db, "ga4_calendly_events_staging", calEventRows, s.errors);
  await insertChunked(db, "calendly_bookings_staging", bookings, s.errors);

  const { data: rebuilt, error: rbErr } = await db.rpc("rebuild_ga4_ac_matches", { window_days: WINDOW_DAYS, tol_seconds: TOL_SECONDS });
  if (rbErr) s.errors.push(`rebuild_ga4_ac_matches: ${rbErr.message}`);
  else s.rebuild = rebuilt;

  console.log("ga4-ads-leads-sync summary:", JSON.stringify(s));
  return s;
}

Deno.serve(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const sync = params.get("sync") === "1" || params.get("sync") === "true";
  if (sync) { const summary = await run(); return json(summary, summary.errors.length ? 207 : 200); }
  const work = run().catch((e) => console.error("run failed:", e instanceof Error ? e.message : String(e)));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  return json({ mode: "async", status: "accepted" }, 202);
});
