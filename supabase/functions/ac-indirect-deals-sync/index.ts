// ac-indirect-deals-sync — rebuilds public.ac_indirect_deals, the cached table of every
// INDIRECT (bureau/PCO/events-company) ActiveCampaign deal (2021 → present).
//
// An indirect deal is defined STRICTLY as a deal whose AC deal custom field
// "Deal Source?" (dealCustomFieldMeta id 6) = "Indirect (PCO/ Bureau/ Events company)".
// That field is NOT mirrored into public.activecampaign_deals, so this function pulls
// the field-6 values straight from the AC REST API, keeps the deal_ids flagged
// Indirect, and hands them to public.reload_ac_indirect_deals(_ids), which rebuilds the
// table by joining those ids back onto the local deal mirror (+ contacts/accounts).
//
// Efficient pull: one paginated sweep of /dealCustomFieldMeta/6/dealCustomFieldData
// (all deals' Deal Source value in a single field feed) — NOT per-deal reads.
//
// Invoke:
//   GET/POST ?dry=1   preview only — returns the counts, writes nothing.
//   GET/POST ?sync=1  runs inline and rebuilds the table (200, or 500 on failure).
//   GET/POST (bare)   runs in the background via EdgeRuntime.waitUntil, returns 202.
//
// Secrets required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AC_API_URL, AC_API_TOKEN.
// Optional (failure-alert email, same as the other AC syncs):
//   GMAIL_USER, GMAIL_APP_PASSWORD, ALERT_EMAIL, WALL_CLOCK_MS (default 180000).
//
// Deploy command (MUST be --no-verify-jwt so the pg_cron/pg_net call with no auth header runs):
//   supabase functions deploy ac-indirect-deals-sync --no-verify-jwt

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

// "Deal Source?" = dealCustomFieldMeta id 6; the one Indirect option is the marker.
const DEAL_SOURCE_FIELD_ID = Deno.env.get("DEAL_SOURCE_FIELD_ID") ?? "6";
const INDIRECT_PREFIX = "indirect"; // the only "Indirect (PCO/ Bureau/ Events company)" option

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

// Normalise a dropdown value: AC stores the option LABEL for this field, but strip
// the leading "||" multi-value markers AC sometimes wraps dropdown values in.
function cleanVal(v: unknown): string {
  return String(v ?? "").replace(/\|\|/g, "").trim();
}

type IndirectId = { id: string; source: string };

// Sweep the whole "Deal Source?" field feed and keep the Indirect deals.
async function fetchIndirectIds(started: number, summary: Summary): Promise<IndirectId[]> {
  const byDeal = new Map<string, string>();
  let offset = 0;
  while (true) {
    if (Date.now() - started > WALL_CLOCK_MS - 20000) {
      throw new Error(`Wall-clock budget hit after ${summary.pages} pages — aborting before reload`);
    }
    const d = await acGet(
      `dealCustomFieldMeta/${DEAL_SOURCE_FIELD_ID}/dealCustomFieldData?limit=${PAGE_SIZE}&offset=${offset}`,
    );
    // NB: this nested feed returns the field-6 value rows under the key
    // `dealCustomFieldMeta` (one row per deal, each with dealId + fieldValue).
    const items = Array.isArray(d?.dealCustomFieldMeta) ? d.dealCustomFieldMeta : [];
    summary.pages += 1;
    summary.field_rows += items.length;
    for (const it of items) {
      const dealId = String(it.dealId ?? it.deal ?? "");
      if (!dealId) continue;
      const val = cleanVal(it.fieldValue);
      if (val.toLowerCase().startsWith(INDIRECT_PREFIX)) byDeal.set(dealId, val);
    }
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return [...byDeal.entries()].map(([id, source]) => ({ id, source }));
}

type Summary = {
  fn: string;
  pages: number;
  field_rows: number;      // total field-6 data rows seen
  indirect_deals: number;  // deals flagged Indirect in AC
  reloaded_rows: number;   // rows written (indirect deals also present in the mirror)
  dry: boolean;
  duration_ms: number;
  ok: boolean;
  error: string | null;
};

async function sendFailureEmail(summary: Summary, detail: string): Promise<void> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error("[ac-indirect-deals-sync] alert email NOT sent — GMAIL_USER/GMAIL_APP_PASSWORD not set");
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
      subject: "⚠️ ac-indirect-deals-sync FAILED",
      content: "auto",
      html: `<p>The <b>ac-indirect-deals-sync</b> edge function failed. The
        <code>ac_indirect_deals</code> table was <b>NOT</b> modified (the reload is
        transactional, so the previous rows are preserved).</p>
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
    fn: "ac-indirect-deals-sync",
    pages: 0,
    field_rows: 0,
    indirect_deals: 0,
    reloaded_rows: 0,
    dry,
    duration_ms: 0,
    ok: false,
    error: null,
  };

  try {
    if (!AC_API_URL || !AC_API_TOKEN) throw new Error("Missing AC_API_URL / AC_API_TOKEN");
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // 1. Pull the indirect deal_ids straight from the AC "Deal Source?" field feed.
    const ids = await fetchIndirectIds(started, summary);
    summary.indirect_deals = ids.length;

    // Guard: an empty result is treated as a failure so we never wipe the table.
    if (ids.length === 0) {
      throw new Error("0 indirect deals returned from AC — treating as failure, table left unchanged");
    }

    if (dry) {
      summary.ok = true;
      summary.duration_ms = Date.now() - started;
      console.log("[ac-indirect-deals-sync] DRY:", JSON.stringify(summary));
      return summary;
    }

    // 2. Atomic rebuild (delete all → insert, joined onto the mirror) in one transaction.
    const { data, error } = await db.rpc("reload_ac_indirect_deals", { _ids: ids });
    if (error) throw new Error(`reload_ac_indirect_deals failed: ${error.message}`);
    summary.reloaded_rows = typeof data === "number" ? data : ids.length;

    summary.ok = true;
    summary.duration_ms = Date.now() - started;
    console.log("[ac-indirect-deals-sync] done:", JSON.stringify(summary));
    return summary;
  } catch (err) {
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : String(err);
    summary.duration_ms = Date.now() - started;
    console.error("[ac-indirect-deals-sync] FAILED:", summary.error);
    if (!dry) {
      try { await sendFailureEmail(summary, summary.error); }
      catch (mailErr) { console.error("[ac-indirect-deals-sync] failed to send alert email:", mailErr); }
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
  const dry = url.searchParams.get("dry") === "1";
  const sync = url.searchParams.get("sync") === "1";

  if (dry || sync) {
    const res = await run(dry);
    return json(res, res.ok ? 200 : 500);
  }

  // Async mode (how the pg_cron job calls it): return 202, run in background.
  if (EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(run(false));
    return json({ message: "ac-indirect-deals-sync started in background", timestamp: new Date().toISOString() }, 202);
  }

  const res = await run(false);
  return json(res, res.ok ? 200 : 500);
});
