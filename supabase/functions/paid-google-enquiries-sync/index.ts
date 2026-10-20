// paid-google-enquiries-sync
// ---------------------------------------------------------------------------
// Keeps the dashboard "Historical Paid Leads" cache (public.mag_paid_google_enquiries)
// current. The table is ANCHORED to a fixed set of 39 AC deal_ids — the
// "Paid – Google" enquiries the MAG Enquiry & Deal Reconciliation sheet identified
// (seeded once; the reconciliation-only columns are authoritative there). This
// function refreshes only the AC-LIVE display columns for those deals from the
// Supabase ActiveCampaign mirror — i.e. it pulls from the same source the sheet
// pulls from, not the sheet itself.
//
// Per run:
//   1. Read the anchored deal_ids already in mag_paid_google_enquiries.
//   2. Look each up in activecampaign_deals (+ contacts, accounts, ac_google_ads_deals).
//   3. UPSERT on deal_id, writing ONLY the AC-live columns (+ last_synced_at/updated_at).
//      Seed-static columns are never included in the payload, so they are preserved.
//
// NEVER truncates/rebuilds — it only upserts the anchored rows. It also never
// inserts a NEW deal_id (payloads target existing anchored ids only), so the
// historical set stays fixed.
//
// Invoke: POST/GET ?sync=1 runs inline + returns a summary (manual/backfill);
//         bare POST/GET returns 202 and runs in the background (cron).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Deploy: Supabase MCP deploy_edge_function, verify_jwt:false.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });

// activecampaign_deals.status -> outcome label.
function outcomeOf(status: number | null): string {
  if (status === 1) return "won";
  if (status === 2) return "lost";
  return "open"; // 0 (and anything else) -> open
}

async function fetchByIds<T extends Record<string, unknown>>(
  db: SupabaseClient, table: string, cols: string, key: string, ids: string[],
): Promise<Map<string, T>> {
  const map = new Map<string, T>();
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  const CHUNK = 200;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const { data, error } = await db.from(table).select(cols).in(key, slice);
    if (error) { console.warn(`${table} lookup: ${error.message}`); continue; }
    for (const row of (data ?? []) as unknown as T[]) map.set(String(row[key]), row);
  }
  return map;
}

interface Summary {
  fn: string; anchored: number; matched_in_mirror: number; upserted: number;
  missing_from_mirror: string[]; errors: string[]; ran_at: string;
}

async function run(): Promise<Summary> {
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const now = () => new Date().toISOString();
  const s: Summary = {
    fn: "paid-google-enquiries-sync", anchored: 0, matched_in_mirror: 0,
    upserted: 0, missing_from_mirror: [], errors: [], ran_at: now(),
  };

  // 1. The anchored deal_ids + the current values of the fields we only
  //    CONDITIONALLY overwrite — so a batch upsert (which uses the union of all
  //    rows' keys) can carry a uniform key set and never null a seeded value for
  //    a row the mirror doesn't cover (e.g. google_ads_field "No" on tag-based deals).
  const { data: anchorRows, error: anchorErr } = await db
    .from("mag_paid_google_enquiries")
    .select("deal_id, organisation, contact, google_ads_field");
  if (anchorErr) { s.errors.push(`anchor read: ${anchorErr.message}`); return s; }
  const existing = new Map<string, { organisation: string | null; contact: string | null; google_ads_field: string | null }>();
  for (const r of (anchorRows ?? []) as any[]) {
    existing.set(String(r.deal_id), { organisation: r.organisation ?? null, contact: r.contact ?? null, google_ads_field: r.google_ads_field ?? null });
  }
  const ids = (anchorRows ?? []).map((r: any) => String(r.deal_id));
  s.anchored = ids.length;
  if (!ids.length) return s;

  // 2. Live fields from the AC mirror.
  const deals = await fetchByIds<{
    id: string; status: number | null; value: number | null; currency: string | null;
    cdate: string | null; title: string | null; contact: string | null; account: string | null;
  }>(db, "activecampaign_deals", "id, status, value, currency, cdate, title, contact, account", "id", ids);

  const contactIds = Array.from(deals.values()).map((d) => d.contact ?? "").filter(Boolean);
  const accountIds = Array.from(deals.values()).map((d) => d.account ?? "").filter(Boolean);
  const contacts = await fetchByIds<{ id: string; firstName: string | null; lastName: string | null; email: string | null; cdate: string | null }>(
    db, "activecampaign_contacts", "id, firstName, lastName, email, cdate", "id", contactIds);
  const accounts = await fetchByIds<{ id: string; name: string | null }>(
    db, "activecampaign_accounts", "id, name", "id", accountIds);
  const gads = await fetchByIds<{ deal_id: string; google_ads_field: string | null }>(
    db, "ac_google_ads_deals", "deal_id, google_ads_field", "deal_id", ids);

  // 3. Build + upsert the AC-live columns (seed-static columns omitted => preserved).
  const records: Record<string, unknown>[] = [];
  for (const id of ids) {
    const d = deals.get(id);
    if (!d) { s.missing_from_mirror.push(id); continue; }
    s.matched_in_mirror++;
    const con = d.contact ? contacts.get(String(d.contact)) : undefined;
    const acc = d.account ? accounts.get(String(d.account)) : undefined;
    const value = d.value != null ? Number(d.value) / 100 : null;
    const outcome = outcomeOf(d.status);
    const rec: Record<string, unknown> = {
      deal_id: id,
      enquiry_date: d.cdate ?? null,
      contact_created: con?.cdate ?? null,
      deal_title: d.title ?? null,
      deal_value_aud: value,
      won_value_aud: outcome === "won" ? value : 0,
      outcome,
      email: con?.email ?? null,
      last_synced_at: now(),
      updated_at: now(),
    };
    // Uniform key set: fall back to the existing (seeded) value when the mirror
    // has nothing, so the batch upsert never nulls a seeded reconciliation value.
    const prev = existing.get(id);
    rec.organisation = acc?.name ?? prev?.organisation ?? null;
    const name = [con?.firstName ?? "", con?.lastName ?? ""].join(" ").trim();
    rec.contact = name || prev?.contact || null;
    rec.google_ads_field = gads.get(id)?.google_ads_field ?? prev?.google_ads_field ?? null;
    records.push(rec);
  }

  const CHUNK = 100;
  for (let i = 0; i < records.length; i += CHUNK) {
    const slice = records.slice(i, i + CHUNK);
    const { error } = await db
      .from("mag_paid_google_enquiries")
      .upsert(slice, { onConflict: "deal_id" });
    if (error) s.errors.push(`upsert: ${error.message}`);
    else s.upserted += slice.length;
  }

  console.log("paid-google-enquiries-sync summary:", JSON.stringify(s));
  return s;
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
  const sync = new URL(req.url).searchParams.get("sync");
  if (sync === "1" || sync === "true") {
    const summary = await run();
    return json({ mode: "sync", ...summary }, summary.errors.length ? 500 : 200);
  }
  const work = run().catch((e) => console.error("run failed:", e instanceof Error ? e.message : String(e)));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  return json({ mode: "async", status: "accepted" }, 202);
});
