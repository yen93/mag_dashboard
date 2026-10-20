// activecampaign-contacts-sync — full refresh of public.activecampaign_contacts from the
// ActiveCampaign REST API. Replaces the old n8n "Get All AC Contacts" workflow
// (webhook 8388b39d-9c99-494e-9991-2fefb0081a87).
//
// Why this exists: the n8n flow DELETEd activecampaign_contacts first and only then
// fetched + inserted, so any error after the delete left the table empty (the same
// destructive-first flaw that blanked activecampaign_deals). This function fetches the
// full snapshot FIRST and only then calls public.reload_activecampaign_contacts(), which
// performs delete + insert in a single transaction (rolls back on failure, so the
// previous rows survive). On ANY failure it emails ALERT_EMAIL.
//
// Invoke:
//   GET/POST ?sync=1  runs inline and returns the detailed summary (200, or 500 on failure).
//   GET/POST (bare)   runs in the background via EdgeRuntime.waitUntil and returns 202.
//
// Secrets required (all project-wide, already set from activecampaign-deals-sync):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AC_API_URL, AC_API_TOKEN,
//   GMAIL_USER, GMAIL_APP_PASSWORD        (failure-alert email via Gmail SMTP)
// Optional:
//   ALERT_EMAIL (default julienne@myadventuregroup.com.au), WALL_CLOCK_MS (default 140000)
//
// Deploy command (MUST be --no-verify-jwt so the pg_cron/pg_net call with no auth header runs):
//   supabase functions deploy activecampaign-contacts-sync --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AC_API_URL = (Deno.env.get("AC_API_URL") ?? "").replace(/\/+$/, "");
const AC_API_TOKEN = Deno.env.get("AC_API_TOKEN") ?? "";

const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
const ALERT_EMAIL = Deno.env.get("ALERT_EMAIL") ?? "julienne@myadventuregroup.com.au";

// Keep the internal budget below the ~150s edge-gateway wall clock so the guard below
// trips and we fail cleanly (with an alert email) instead of being killed with a silent 504.
const WALL_CLOCK_MS = parseInt(Deno.env.get("WALL_CLOCK_MS") ?? "140000", 10);
const PAGE_SIZE = 100;          // AC v3 hard max page size
const CONCURRENCY = 4;          // pages fetched in parallel (AC limit is ~5 req/s/account)
const BATCH_PAUSE_MS = 400;     // pacing between batches to stay under the rate limit

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });

// ---- ActiveCampaign REST v3 ------------------------------------------------
const acHeaders = { "Api-Token": AC_API_TOKEN, "Content-Type": "application/json" };

async function acGet(path: string, tries = 0): Promise<any> {
  const r = await fetch(`${AC_API_URL}/api/3/${path}`, { headers: acHeaders });
  if (!r.ok) {
    if (r.status === 429 && tries < 5) {
      await sleep(1500);
      return acGet(path, tries + 1);
    }
    throw new Error(`ActiveCampaign ${r.status} for ${path}: ${(await r.text()).slice(0, 300)}`);
  }
  return await r.json();
}

// Only the fields that map to activecampaign_contacts columns (keeps the rpc payload small).
// NB: the AC `links` object (just a bundle of per-contact API URLs) is deliberately NOT
// fetched — it is ~1.6 kB/row (≈85% of the table's bytes), nothing in the dashboard reads
// activecampaign_contacts.links, and sending it made the single rpc payload ~38 MB and blew
// the edge wall clock. The reload rpc stores '{}' for links. scoreValues/accountContacts are
// tiny (arrays of ids) so they are kept.
const CONTACT_KEYS = [
  "id", "email", "phone", "firstName", "lastName", "orgid", "orgname", "organization",
  "segmentio_id", "bounced_hard", "bounced_soft", "bounced_date", "ip", "ua", "hash",
  "socialdata_lastcheck", "email_local", "email_domain", "sentcnt", "rating_tstamp",
  "gravatar", "deleted", "anonymized", "adate", "udate", "edate", "cdate", "deleted_at",
  "created_utc_timestamp", "updated_utc_timestamp", "created_timestamp", "updated_timestamp",
  "created_by", "updated_by", "mpp_tracking", "last_click_date", "last_open_date",
  "last_mpp_open_date", "best_send_hour", "sms_consent", "sms_consent_updated_at",
  "whatsapp_id", "whatsapp_username", "scoreValues", "accountContacts",
] as const;

function trimContact(c: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CONTACT_KEYS) if (c[k] !== undefined) out[k] = c[k];
  return out;
}

type Summary = {
  fn: string;
  fetched_contacts: number;
  reloaded_rows: number;
  pages: number;
  duration_ms: number;
  ok: boolean;
  error: string | null;
};

async function sendFailureEmail(summary: Summary, detail: string): Promise<void> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error("[activecampaign-contacts-sync] alert email NOT sent — GMAIL_USER/GMAIL_APP_PASSWORD not set");
    return;
  }
  const client = new SMTPClient({
    connection: { hostname: "smtp.gmail.com", port: 465, tls: true,
      auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD } },
  });
  try {
    await client.send({
      from: GMAIL_USER,
      to: ALERT_EMAIL,
      subject: "⚠️ activecampaign-contacts-sync FAILED",
      content: "auto",
      html: `<p>The <b>activecampaign-contacts-sync</b> edge function failed. The
        <code>activecampaign_contacts</code> table was <b>NOT</b> modified (the reload is
        transactional, so the previous rows are preserved).</p>
        <p><b>Error:</b></p><pre>${detail.replace(/[<>&]/g, (c) =>
          ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string))}</pre>
        <p><b>Summary:</b></p><pre>${JSON.stringify(summary, null, 2)}</pre>
        <p>Ran at ${new Date().toISOString()}</p>`,
    });
    console.log("[activecampaign-contacts-sync] failure alert emailed to", ALERT_EMAIL);
  } finally {
    await client.close();
  }
}

async function run(): Promise<Summary> {
  const started = Date.now();
  const summary: Summary = {
    fn: "activecampaign-contacts-sync",
    fetched_contacts: 0,
    reloaded_rows: 0,
    pages: 0,
    duration_ms: 0,
    ok: false,
    error: null,
  };

  try {
    if (!AC_API_URL || !AC_API_TOKEN) throw new Error("Missing AC_API_URL / AC_API_TOKEN");
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // 1. Fetch the FULL contact snapshot from AC first (never touch the table until this
    //    succeeds). There are ~15k contacts (~155 pages), so fetch the first page to learn
    //    meta.total, then pull the rest in bounded-concurrency batches — sequential pages
    //    would blow the edge-function wall clock.
    const contacts: Record<string, unknown>[] = [];
    const first = await acGet(`contacts?limit=${PAGE_SIZE}&offset=0`);
    const firstItems = Array.isArray(first?.contacts) ? first.contacts : [];
    for (const it of firstItems) contacts.push(trimContact(it));
    summary.pages = 1;

    const total = parseInt(first?.meta?.total ?? `${firstItems.length}`, 10) || firstItems.length;
    const offsets: number[] = [];
    for (let o = PAGE_SIZE; o < total; o += PAGE_SIZE) offsets.push(o);

    for (let i = 0; i < offsets.length; i += CONCURRENCY) {
      if (Date.now() - started > WALL_CLOCK_MS - 20000) {
        throw new Error(`Wall-clock budget hit after ${summary.pages} pages / ${contacts.length} contacts — aborting before reload`);
      }
      const batch = offsets.slice(i, i + CONCURRENCY);
      const pages = await Promise.all(
        batch.map((o) => acGet(`contacts?limit=${PAGE_SIZE}&offset=${o}`)),
      );
      for (const d of pages) {
        const items = Array.isArray(d?.contacts) ? d.contacts : [];
        for (const it of items) contacts.push(trimContact(it));
        summary.pages += 1;
      }
      if (i + CONCURRENCY < offsets.length) await sleep(BATCH_PAUSE_MS);
    }
    summary.fetched_contacts = contacts.length;

    // Guard: an empty fetch is treated as a failure so we never wipe the table.
    if (contacts.length === 0) throw new Error("ActiveCampaign returned 0 contacts — treating as failure, table left unchanged");

    // 2. Atomic reload (delete all -> insert all) inside one transaction.
    const { data, error } = await db.rpc("reload_activecampaign_contacts", { _contacts: contacts });
    if (error) throw new Error(`reload_activecampaign_contacts failed: ${error.message}`);
    summary.reloaded_rows = typeof data === "number" ? data : contacts.length;

    summary.ok = true;
    summary.duration_ms = Date.now() - started;
    console.log("[activecampaign-contacts-sync] done:", JSON.stringify(summary));
    return summary;
  } catch (err) {
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : String(err);
    summary.duration_ms = Date.now() - started;
    console.error("[activecampaign-contacts-sync] FAILED:", summary.error);
    try {
      await sendFailureEmail(summary, summary.error);
    } catch (mailErr) {
      console.error("[activecampaign-contacts-sync] failed to send alert email:", mailErr);
    }
    return summary;
  }
}

// ---- HTTP handler ----------------------------------------------------------
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
  const sync = url.searchParams.get("sync") === "1";

  if (sync) {
    const res = await run();
    return json(res, res.ok ? 200 : 500);
  }

  // Async mode (how the pg_cron job calls it): return 202 immediately, run in background.
  if (EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(run());
    return json({ message: "activecampaign-contacts-sync started in background", timestamp: new Date().toISOString() }, 202);
  }

  const res = await run();
  return json(res, res.ok ? 200 : 500);
});
