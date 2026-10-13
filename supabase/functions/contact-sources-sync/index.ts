// contact-sources-sync — single orchestrator for the Contact Sources tab pipeline.
//
// Runs the whole chain from ONE scheduled job, calling the existing sync edge
// functions. The individual functions are kept as-is; only their individual cron
// schedules are removed (see
// supabase/migrations/20261009000100_schedule_contact_sources_sync.sql).
//
// Why two groups (a single worker can't await all three — see below):
//   ac-google-ads-deals-sync takes ~130s and is INDEPENDENT of the rebuild
//   (rebuild_ga4_ac_matches does not read ac_google_ads_deals, and the Contact
//   Sources query doesn't join it). Awaiting it inline blew the ~150-170s edge
//   worker limit before the dependent steps could run. So:
//
//   * FIRE-AND-FORGET (async, its own worker): ac-google-ads-deals-sync
//   * CRITICAL PATH (awaited, in order):        ga4-ads-leads-sync  ->  ga4-ac-custom-fields-sync
//        step 2 truncates + rebuilds ga4_ac_contact_source / ga4_ac_event_matches,
//        denormalizes the display columns, AND appends Google Ads deal leads from
//        ac_google_ads_deals whose email isn't already matched (section 4 of
//        rebuild_ga4_ac_matches — GA4/match columns left NULL). Step 3 then fills
//        google_ads_ac_field / deal_source_ac_field on the rebuilt rows. Awaiting
//        just these two is ~70s — well within budget.
//        NB: the appended leads come from the PRIOR run's ac_google_ads_deals
//        snapshot, since ac-google-ads-deals-sync (~138s) is fire-and-forget and
//        can't be awaited before the rebuild without blowing the worker limit — a
//        brand-new Google Ads lead therefore surfaces within ~1 day.
//
// All functions are deployed verify_jwt=false, so the calls send NO Authorization
// header (Content-Type only). See CLAUDE.md "Supabase Edge Functions must be
// deployed --no-verify-jwt".
//
// Invoke:
//   GET/POST ?sync=1 runs inline and returns the combined summary (manual/backfill).
//   GET/POST (bare) returns 202 immediately and runs in the background via
//     EdgeRuntime.waitUntil — this is what the cron job uses.
//
// Secrets required: SUPABASE_URL (used to derive the functions base URL).
//
// Deploy command:
//   supabase functions deploy contact-sources-sync --no-verify-jwt

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "https://aivitcomiywiysrfwqxt.supabase.co")
  .replace(/\/+$/, "");
const FUNCTIONS_BASE = `${SUPABASE_URL}/functions/v1`;

// Per-step fetch timeout for the awaited steps.
const STEP_TIMEOUT_MS = parseInt(Deno.env.get("STEP_TIMEOUT_MS") ?? "160000", 10);

// Independent + slow: kicked off async, left to run in its own worker.
const FIRE_AND_FORGET = ["ac-google-ads-deals-sync"] as const;
// Ordered, dependent: awaited one after the other (step 2 must finish before step 3).
const SEQUENTIAL = ["ga4-ads-leads-sync", "ga4-ac-custom-fields-sync"] as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });

// Kick off a function in its own background worker (?sync omitted => 202) and
// return once it has accepted the request. Does NOT wait for the work to finish.
async function fireAndForget(name: string) {
  const url = `${FUNCTIONS_BASE}/${name}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // no Authorization — verify_jwt=false
      body: "{}",
      signal: controller.signal,
    });
    return { step: name, mode: "async", triggered: res.status === 202 || res.ok, status: res.status, duration_ms: Date.now() - started };
  } catch (e: any) {
    return { step: name, mode: "async", triggered: false, status: 0, duration_ms: Date.now() - started, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Run a function inline (?sync=1) and wait for its full summary.
async function callStep(name: string) {
  const url = `${FUNCTIONS_BASE}/${name}?sync=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // no Authorization — verify_jwt=false
      body: "{}",
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep raw text */ }
    return { step: name, mode: "sync", ok: res.ok, status: res.status, duration_ms: Date.now() - started, summary: body };
  } catch (e: any) {
    return {
      step: name,
      mode: "sync",
      ok: false,
      status: 0,
      duration_ms: Date.now() - started,
      error: e?.name === "AbortError" ? `timed out after ${STEP_TIMEOUT_MS}ms` : (e?.message || String(e)),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  const started = Date.now();

  // 1. kick off the independent, slow step in its own worker (not awaited).
  const triggered = [];
  for (const name of FIRE_AND_FORGET) {
    const t = await fireAndForget(name);
    triggered.push(t);
    console.log(`[contact-sources-sync] fired ${name}: triggered=${t.triggered} status=${t.status}`);
  }

  // 2. run the ordered critical path, awaiting each in turn.
  const results = [];
  for (const name of SEQUENTIAL) {
    const r = await callStep(name);
    results.push(r);
    console.log(`[contact-sources-sync] ${name}: ok=${r.ok} status=${r.status} (${r.duration_ms}ms)`);
  }

  return {
    ok: results.every((r) => r.ok),
    triggered,
    awaited: results.length,
    failed: results.filter((r) => !r.ok).map((r) => r.step),
    duration_ms: Date.now() - started,
    results,
    ran_at: new Date().toISOString(),
  };
}

// ---- HTTP Handler ----------------------------------------------------------
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

  // Async mode (cron): return 202 immediately and run the chain in the background.
  if (EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(
      run().then((summary) => console.log("[contact-sources-sync] done:", JSON.stringify(summary)))
    );
    return json({ message: "Contact Sources sync started in background", timestamp: new Date().toISOString() }, 202);
  }

  const res = await run();
  return json(res, res.ok ? 200 : 500);
});
