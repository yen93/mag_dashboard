// activecampaign-deals-sync — full refresh of public.activecampaign_deals from the
// ActiveCampaign REST API. Replaces the old n8n "Get All AC Deals" workflow
// (webhook 02b6362d-b828-4f40-908c-45e98a943a2b).
//
// Why this exists: the n8n flow DELETEd activecampaign_deals first and only then
// fetched + inserted, so any error after the delete left the table empty — which
// silently blanked the deal columns on the GA4 / Contact Sources page. This function
// fetches the full snapshot FIRST and only then calls public.reload_activecampaign_deals(),
// which performs null-refs → delete → insert in a single transaction (rolls back on
// failure, so the previous rows survive). On ANY failure it emails ALERT_EMAIL.
//
// Invoke:
//   GET/POST ?sync=1  runs inline and returns the detailed summary (200, or 500 on failure).
//   GET/POST (bare)   runs in the background via EdgeRuntime.waitUntil and returns 202.
//
// Secrets required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AC_API_URL, AC_API_TOKEN,
//   GMAIL_USER, GMAIL_APP_PASSWORD        (failure-alert email via Gmail SMTP)
// Optional:
//   ALERT_EMAIL (default julienne@myadventuregroup.com.au), WALL_CLOCK_MS (default 180000)
//
// Deploy command (MUST be --no-verify-jwt so the pg_cron/pg_net call with no auth header runs):
//   supabase functions deploy activecampaign-deals-sync --no-verify-jwt

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

const WALL_CLOCK_MS = parseInt(Deno.env.get("WALL_CLOCK_MS") ?? "180000", 10);
const PAGE_SIZE = 100;

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

// Only the fields that map to activecampaign_deals columns (keeps the rpc payload small).
const DEAL_KEYS = [
  "id", "hash", "owner", "contact", "organization", "group", "stage", "title",
  "description", "percent", "cdate", "mdate", "nextdate", "nexttaskid", "value",
  "currency", "winProbability", "winProbabilityMdate", "status", "activitycount",
  "nextdealid", "edate", "links", "isDisabled", "account", "customerAccount",
] as const;

function trimDeal(d: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of DEAL_KEYS) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

type Summary = {
  fn: string;
  fetched_deals: number;
  reloaded_rows: number;
  pages: number;
  duration_ms: number;
  ok: boolean;
  error: string | null;
};

async function sendFailureEmail(summary: Summary, detail: string): Promise<void> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error("[activecampaign-deals-sync] alert email NOT sent — GMAIL_USER/GMAIL_APP_PASSWORD not set");
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
      subject: "⚠️ activecampaign-deals-sync FAILED",
      content: "auto",
      html: `<p>The <b>activecampaign-deals-sync</b> edge function failed. The
        <code>activecampaign_deals</code> table was <b>NOT</b> modified (the reload is
        transactional, so the previous rows are preserved).</p>
        <p><b>Error:</b></p><pre>${detail.replace(/[<>&]/g, (c) =>
          ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string))}</pre>
        <p><b>Summary:</b></p><pre>${JSON.stringify(summary, null, 2)}</pre>
        <p>Ran at ${new Date().toISOString()}</p>`,
    });
    console.log("[activecampaign-deals-sync] failure alert emailed to", ALERT_EMAIL);
  } finally {
    await client.close();
  }
}

async function run(): Promise<Summary> {
  const started = Date.now();
  const summary: Summary = {
    fn: "activecampaign-deals-sync",
    fetched_deals: 0,
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

    // 1. Fetch the FULL deal snapshot from AC first (never touch the table until this succeeds).
    const deals: Record<string, unknown>[] = [];
    let offset = 0;
    while (true) {
      if (Date.now() - started > WALL_CLOCK_MS - 20000) {
        throw new Error(`Wall-clock budget hit after ${summary.pages} pages / ${deals.length} deals — aborting before reload`);
      }
      const d = await acGet(`deals?limit=${PAGE_SIZE}&offset=${offset}`);
      const items = Array.isArray(d?.deals) ? d.deals : [];
      summary.pages += 1;
      for (const it of items) deals.push(trimDeal(it));
      if (items.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    summary.fetched_deals = deals.length;

    // Guard: an empty fetch is treated as a failure so we never wipe the table.
    if (deals.length === 0) throw new Error("ActiveCampaign returned 0 deals — treating as failure, table left unchanged");

    // 2. Atomic reload (null FK refs -> delete all -> insert all) inside one transaction.
    const { data, error } = await db.rpc("reload_activecampaign_deals", { _deals: deals });
    if (error) throw new Error(`reload_activecampaign_deals failed: ${error.message}`);
    summary.reloaded_rows = typeof data === "number" ? data : deals.length;

    summary.ok = true;
    summary.duration_ms = Date.now() - started;
    console.log("[activecampaign-deals-sync] done:", JSON.stringify(summary));
    return summary;
  } catch (err) {
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : String(err);
    summary.duration_ms = Date.now() - started;
    console.error("[activecampaign-deals-sync] FAILED:", summary.error);
    try {
      await sendFailureEmail(summary, summary.error);
    } catch (mailErr) {
      console.error("[activecampaign-deals-sync] failed to send alert email:", mailErr);
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
    return json({ message: "activecampaign-deals-sync started in background", timestamp: new Date().toISOString() }, 202);
  }

  const res = await run();
  return json(res, res.ok ? 200 : 500);
});
