// new-paid-leads-sync — fills public.ac_new_leads, the cache table behind the
// dashboard "New Paid Leads Tracking" page (GET /api/operations/new-paid-leads).
// Runs Mon-Fri 06:00 PH via pg_cron. Mirrors the buyer-sheet-sync / sales-deals-sync
// pattern: one wide cache table, UPSERTed (never truncated) on contact_id, so the
// Node/Express dashboard does a plain SELECT and makes zero AC calls at request time.
//
// Scope: every ActiveCampaign CONTACT created on/after 5 Oct 2026 Philippine time
// (= 2026-10-04T16:00:00Z, since AC cdate is UTC) OR last-updated on/after that
// cutoff (so an older contact that gets a new form submit / Src field after the
// cutoff is included too). For each contact we capture the 11 "Src - *" acquisition
// custom fields (contact field ids 77-87) that the website forms now write at submit
// time (utm_*, gclid, msclkid, landing page, referrer, first-touch), plus a derived
// "source / medium" channel and an is_paid flag.
//
// Read-only against AC; only writes public.ac_new_leads.
//
// Invoke: POST/GET ?sync=1 (inline + summary) ?since=YYYY-MM-DD (override cutoff).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AC_API_URL, AC_API_TOKEN.
// Deploy: Supabase MCP deploy_edge_function, verify_jwt:false.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AC_API_URL = (Deno.env.get("AC_API_URL") ?? "").replace(/\/+$/, "");
const AC_API_TOKEN = Deno.env.get("AC_API_TOKEN") ?? "";

// 5 Oct 2026 00:00 Philippine time (UTC+8) expressed in UTC. AC cdate/udate are UTC.
const CUTOFF_UTC = "2026-10-04T16:00:00Z";
const WALL_CLOCK_MS = parseInt(Deno.env.get("WALL_CLOCK_MS") ?? "150000", 10);
const MAX_CONTACTS = parseInt(Deno.env.get("MAX_CONTACTS") ?? "50000", 10);

// The 11 "Src - *" ActiveCampaign CONTACT custom field ids -> our column names.
const SRC_FIELDS: Record<string, string> = {
  "77": "src_lead_channel",
  "78": "src_utm_source",
  "79": "src_utm_medium",
  "80": "src_utm_campaign",
  "81": "src_utm_term",
  "82": "src_gclid",
  "83": "src_msclkid",
  "84": "src_landing_page",
  "85": "src_referrer",
  "86": "src_ft_channel",
  "87": "src_ft_landing_page",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const clean = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};
const low = (v: unknown): string => String(v ?? "").toLowerCase().trim();

// Derive the dashboard "source / medium" channel (same shape as the historical
// Lead Source Tracking tab), with sensible fallbacks from the click ids.
function deriveChannel(src: string | null, med: string | null, gclid: string | null, msclkid: string | null): string | null {
  const s = low(src), m = low(med);
  if (s && m) return `${s} / ${m}`;
  if (gclid) return "google / cpc";
  if (msclkid) return "bing / cpc";
  if (s) return `${s} / (none)`;
  if (m) return `(direct) / ${m}`;
  return null;
}
const PAID_MEDIA = new Set(["cpc", "ppc", "paid", "paidsearch", "paid-search", "paid_search", "display", "cpm"]);
function derivePaid(med: string | null, gclid: string | null, msclkid: string | null): boolean {
  return !!gclid || !!msclkid || PAID_MEDIA.has(low(med));
}

interface AcContact {
  id: string; email: string | null; firstName: string | null; lastName: string | null;
  phone: string | null; cdate: string | null; udate: string | null;
}
interface LeadRecord {
  contact_id: string; email: string | null; first_name: string | null; last_name: string | null;
  phone: string | null; cdate: string | null; udate: string | null;
  src_lead_channel: string | null; src_utm_source: string | null; src_utm_medium: string | null;
  src_utm_campaign: string | null; src_utm_term: string | null; src_gclid: string | null;
  src_msclkid: string | null; src_landing_page: string | null; src_referrer: string | null;
  src_ft_channel: string | null; src_ft_landing_page: string | null;
  channel: string | null; is_paid: boolean;
  first_synced_at: string; last_synced_at: string; updated_at: string;
}

// ---- ActiveCampaign REST v3 ----------------------------------------------
const acHeaders = { "Api-Token": AC_API_TOKEN, "Content-Type": "application/json" };
async function acGet(path: string): Promise<any | null> {
  try {
    const r = await fetch(`${AC_API_URL}/api/3/${path}`, { headers: acHeaders });
    if (!r.ok) { if (r.status === 429) { await sleep(1500); return acGet(path); } console.warn(`AC ${r.status} for ${path}`); return null; }
    return await r.json();
  } catch (err) { console.warn(`AC fetch failed for ${path}: ${err}`); return null; }
}

// Page AC contacts matching one date filter (created_after | updated_after), with
// their Src-* field values embedded, into `contacts` (keyed by id, dedup across
// passes) and `srcByContact` (contact id -> { fieldId -> value }).
async function collectContacts(
  filterKey: "created_after" | "updated_after",
  sinceIso: string,
  contacts: Map<string, AcContact>,
  srcByContact: Map<string, Record<string, string | null>>,
  budget: () => boolean,
): Promise<number> {
  const pageSize = 100;
  let pages = 0;
  for (let offset = 0; offset < MAX_CONTACTS; offset += pageSize) {
    if (budget()) break;
    const qs = new URLSearchParams({
      [`filters[${filterKey}]`]: sinceIso,
      include: "fieldValues",
      limit: String(pageSize),
      offset: String(offset),
    }).toString();
    const d = await acGet(`contacts?${qs}`);
    const batch: AcContact[] = d && Array.isArray(d.contacts) ? d.contacts : [];
    const fieldValues: any[] = d && Array.isArray(d.fieldValues) ? d.fieldValues : [];
    if (!batch.length) break;
    pages++;
    for (const c of batch) contacts.set(String(c.id), c);
    for (const fv of fieldValues) {
      const fid = String(fv.field);
      if (!SRC_FIELDS[fid]) continue;
      const cid = String(fv.contact);
      if (!srcByContact.has(cid)) srcByContact.set(cid, {});
      srcByContact.get(cid)![fid] = clean(fv.value);
    }
    if (batch.length < pageSize) break;
    await sleep(250); // stay under AC's rate limit
  }
  return pages;
}

type Summary = {
  fn: string; cutoff: string; pages_created: number; pages_updated: number;
  contacts_seen: number; in_window: number; upserted: number; with_src: number;
  paid: number; stopped_early: boolean; errors: string[];
};

async function run(sinceIso: string): Promise<Summary> {
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const started = Date.now();
  const now = () => new Date().toISOString();
  const s: Summary = {
    fn: "new-paid-leads-sync", cutoff: sinceIso, pages_created: 0, pages_updated: 0,
    contacts_seen: 0, in_window: 0, upserted: 0, with_src: 0, paid: 0, stopped_early: false, errors: [],
  };
  if (!AC_API_URL || !AC_API_TOKEN) { s.errors.push("missing AC credentials"); return s; }

  const cutoffMs = new Date(CUTOFF_UTC).getTime();
  const budget = () => {
    if (Date.now() - started > WALL_CLOCK_MS) { s.stopped_early = true; return true; }
    return false;
  };

  // Preserve first_synced_at across runs.
  const { data: existData } = await db.from("ac_new_leads").select("contact_id, first_synced_at");
  const firstSeen = new Map<string, string>();
  for (const r of (existData ?? []) as any[]) firstSeen.set(String(r.contact_id), r.first_synced_at);

  // Union of two AC passes: created on/after the cutoff, and updated on/after it
  // (an older contact that got a new form submit / Src field after the cutoff).
  const contacts = new Map<string, AcContact>();
  const srcByContact = new Map<string, Record<string, string | null>>();
  s.pages_created = await collectContacts("created_after", sinceIso, contacts, srcByContact, budget);
  s.pages_updated = await collectContacts("updated_after", sinceIso, contacts, srcByContact, budget);
  s.contacts_seen = contacts.size;

  const records: LeadRecord[] = [];
  for (const c of contacts.values()) {
    const cid = String(c.id);
    // Belt-and-suspenders: AC's date-filter tz handling can vary, so re-check in UTC.
    const cMs = c.cdate ? new Date(c.cdate).getTime() : NaN;
    const uMs = c.udate ? new Date(c.udate).getTime() : NaN;
    const inWindow = (Number.isFinite(cMs) && cMs >= cutoffMs) || (Number.isFinite(uMs) && uMs >= cutoffMs);
    if (!inWindow) continue;
    s.in_window++;
    const fv = srcByContact.get(cid) ?? {};
    const g = (fid: string) => fv[fid] ?? null;
    const src = g("78"), med = g("79"), gclid = g("82"), msclkid = g("83");
    const channel = deriveChannel(src, med, gclid, msclkid);
    const isPaid = derivePaid(med, gclid, msclkid);
    if (Object.keys(fv).length > 0) s.with_src++;
    if (isPaid) s.paid++;
    records.push({
      contact_id: cid,
      email: clean(c.email), first_name: clean(c.firstName), last_name: clean(c.lastName),
      phone: clean(c.phone), cdate: c.cdate ?? null, udate: c.udate ?? null,
      src_lead_channel: g("77"), src_utm_source: src, src_utm_medium: med,
      src_utm_campaign: g("80"), src_utm_term: g("81"), src_gclid: gclid, src_msclkid: msclkid,
      src_landing_page: g("84"), src_referrer: g("85"), src_ft_channel: g("86"),
      src_ft_landing_page: g("87"),
      channel, is_paid: isPaid,
      first_synced_at: firstSeen.get(cid) ?? now(),
      last_synced_at: now(), updated_at: now(),
    });
  }

  // Upsert (never truncate) on contact_id, in chunks.
  const CHUNK = 100;
  for (let i = 0; i < records.length; i += CHUNK) {
    const slice = records.slice(i, i + CHUNK);
    const { error } = await db.from("ac_new_leads").upsert(slice, { onConflict: "contact_id" });
    if (error) s.errors.push(`upsert @${i}: ${error.message}`); else s.upserted += slice.length;
  }

  console.log("new-paid-leads-sync summary:", JSON.stringify(s));
  return s;
}

Deno.serve(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const since = params.get("since"); // optional YYYY-MM-DD override
  const sinceIso = since && /^\d{4}-\d{2}-\d{2}/.test(since) ? since : CUTOFF_UTC;
  const sync = params.get("sync") === "1" || params.get("sync") === "true";
  if (sync) { const summary = await run(sinceIso); return json({ mode: "sync", ...summary }); }
  const work = run(sinceIso).catch((e) => console.error("run failed:", e instanceof Error ? e.message : String(e)));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  return json({ mode: "async", status: "accepted", cutoff: sinceIso }, 202);
});
