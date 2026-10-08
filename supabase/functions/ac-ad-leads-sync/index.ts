// ac-ad-leads-sync — fills public.ac_ad_leads_tagging, the cache table behind the
// dashboard "AC Ad Leads Tagging" page (GET /api/operations/ac-ad-leads).
// Runs Mon-Fri 06:00 PH via pg_cron. Mirrors the new-paid-leads-sync pattern:
// one wide cache table, UPSERTed (never truncated) on contact_id, so the
// Node/Express dashboard does a plain SELECT and makes zero AC calls at request time.
//
// Scope: every ActiveCampaign CONTACT carrying tag id 88
// ("[WEBSITE] google-ads-click-through", applied by automation #93 on a Google Ads
// click). Tag membership lives ONLY in ActiveCampaign, so we fetch the tag-88
// contacts from the AC API, then join their deals from the existing Supabase mirror
// public.activecampaign_deals (value in CENTS → /100; status 0=open/1=won/2=lost;
// currency mixed-case → lower()). For each contact we roll up deal counts + value
// sums by status and pick one representative "primary" deal (won > open > lost,
// then newest, then highest value).
//
// Read-only against AC and against activecampaign_deals; only writes
// public.ac_ad_leads_tagging.
//
// Invoke: POST/GET ?sync=1 (inline + summary). Optional ?tag=NN overrides tag id.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AC_API_URL, AC_API_TOKEN.
// Deploy: Supabase MCP deploy_edge_function, verify_jwt:false.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AC_API_URL = (Deno.env.get("AC_API_URL") ?? "").replace(/\/+$/, "");
const AC_API_TOKEN = Deno.env.get("AC_API_TOKEN") ?? "";

// AC tag "[WEBSITE] google-ads-click-through".
const TAG_ID = Deno.env.get("AC_TAG_ID") ?? "88";
const WALL_CLOCK_MS = parseInt(Deno.env.get("WALL_CLOCK_MS") ?? "150000", 10);
const MAX_CONTACTS = parseInt(Deno.env.get("MAX_CONTACTS") ?? "50000", 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const clean = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};
const low = (v: unknown): string => String(v ?? "").toLowerCase().trim();

interface AcContact {
  id: string; email: string | null; firstName: string | null; lastName: string | null;
  phone: string | null; cdate: string | null;
}
interface DealRow {
  id: string; contact: string | null; title: string | null;
  value: number | null; status: number | null; currency: string | null; cdate: string | null;
}
interface LeadRecord {
  contact_id: string; email: string | null; first_name: string | null; last_name: string | null;
  phone: string | null; contact_cdate: string | null; tagged_at: string | null;
  deals_count: number; won_deals_count: number; open_deals_count: number; lost_deals_count: number;
  deal_value_total: number; won_value_total: number; open_value_total: number;
  primary_deal_id: string | null; primary_deal_title: string | null; primary_deal_value: number | null;
  primary_deal_status: string | null; primary_deal_cdate: string | null; currency: string | null;
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

// Page all AC contacts that carry the tag into `contacts` (keyed by id).
async function collectTaggedContacts(
  tagId: string, contacts: Map<string, AcContact>, budget: () => boolean,
): Promise<number> {
  const pageSize = 100;
  let pages = 0;
  for (let offset = 0; offset < MAX_CONTACTS; offset += pageSize) {
    if (budget()) break;
    const qs = new URLSearchParams({ tagid: tagId, limit: String(pageSize), offset: String(offset) }).toString();
    const d = await acGet(`contacts?${qs}`);
    const batch: AcContact[] = d && Array.isArray(d.contacts) ? d.contacts : [];
    if (!batch.length) break;
    pages++;
    for (const c of batch) contacts.set(String(c.id), c);
    if (batch.length < pageSize) break;
    await sleep(250); // stay under AC's rate limit
  }
  return pages;
}

// status: 0=open, 1=won, 2=lost. Rank for "most significant" primary deal.
const STATUS_LABEL = (s: number | null): string => s === 1 ? "won" : s === 2 ? "lost" : "open";
const STATUS_RANK = (s: number | null): number => s === 1 ? 0 : s === 0 || s == null ? 1 : 2; // won < open < lost
const toDollars = (cents: number | null): number => Math.round(((Number(cents) || 0) / 100) * 100) / 100;

type Summary = {
  fn: string; tag_id: string; pages: number; contacts_seen: number;
  deals_seen: number; upserted: number; with_deal: number; won_deals: number;
  won_value_total: number; stopped_early: boolean; errors: string[];
};

async function run(tagId: string): Promise<Summary> {
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const started = Date.now();
  const now = () => new Date().toISOString();
  const s: Summary = {
    fn: "ac-ad-leads-sync", tag_id: tagId, pages: 0, contacts_seen: 0, deals_seen: 0,
    upserted: 0, with_deal: 0, won_deals: 0, won_value_total: 0, stopped_early: false, errors: [],
  };
  if (!AC_API_URL || !AC_API_TOKEN) { s.errors.push("missing AC credentials"); return s; }

  const budget = () => {
    if (Date.now() - started > WALL_CLOCK_MS) { s.stopped_early = true; return true; }
    return false;
  };

  // 1) Tag membership — the one thing not in Supabase — from the AC API.
  const contacts = new Map<string, AcContact>();
  s.pages = await collectTaggedContacts(tagId, contacts, budget);
  s.contacts_seen = contacts.size;
  const ids = [...contacts.keys()];

  // 2) Deals for those contacts, from the existing Supabase mirror (chunked IN).
  const dealsByContact = new Map<string, DealRow[]>();
  const DEAL_CHUNK = 200;
  for (let i = 0; i < ids.length; i += DEAL_CHUNK) {
    const chunk = ids.slice(i, i + DEAL_CHUNK);
    const { data, error } = await db
      .from("activecampaign_deals")
      .select("id,contact,title,value,status,currency,cdate")
      .in("contact", chunk);
    if (error) { s.errors.push(`deals @${i}: ${error.message}`); continue; }
    for (const d of (data ?? []) as DealRow[]) {
      const cid = String(d.contact);
      if (!dealsByContact.has(cid)) dealsByContact.set(cid, []);
      dealsByContact.get(cid)!.push(d);
      s.deals_seen++;
    }
  }

  // 3) Build one record per tagged contact.
  const records: LeadRecord[] = [];
  for (const c of contacts.values()) {
    const cid = String(c.id);
    const deals = dealsByContact.get(cid) ?? [];

    let won = 0, open = 0, lost = 0, totAll = 0, totWon = 0, totOpen = 0;
    for (const d of deals) {
      const v = toDollars(d.value);
      totAll += v;
      if (d.status === 1) { won++; totWon += v; }
      else if (d.status === 2) { lost++; }
      else { open++; totOpen += v; }
    }
    // Primary deal: won > open > lost, then newest cdate, then highest value.
    const primary = deals.slice().sort((a, b) => {
      const r = STATUS_RANK(a.status) - STATUS_RANK(b.status);
      if (r !== 0) return r;
      const t = (b.cdate ? Date.parse(b.cdate) : 0) - (a.cdate ? Date.parse(a.cdate) : 0);
      if (t !== 0) return t;
      return toDollars(b.value) - toDollars(a.value);
    })[0] ?? null;

    if (deals.length) s.with_deal++;
    s.won_deals += won;
    s.won_value_total += totWon;

    records.push({
      contact_id: cid,
      email: clean(c.email), first_name: clean(c.firstName), last_name: clean(c.lastName),
      phone: clean(c.phone), contact_cdate: c.cdate ?? null, tagged_at: null,
      deals_count: deals.length, won_deals_count: won, open_deals_count: open, lost_deals_count: lost,
      deal_value_total: totAll, won_value_total: totWon, open_value_total: totOpen,
      primary_deal_id: primary ? String(primary.id) : null,
      primary_deal_title: primary ? clean(primary.title) : null,
      primary_deal_value: primary ? toDollars(primary.value) : null,
      primary_deal_status: primary ? STATUS_LABEL(primary.status) : null,
      primary_deal_cdate: primary ? (primary.cdate ?? null) : null,
      currency: primary ? low(primary.currency) || null : null,
      first_synced_at: now(), last_synced_at: now(), updated_at: now(),
    });
  }

  // Preserve first_synced_at across runs.
  const { data: existData } = await db.from("ac_ad_leads_tagging").select("contact_id, first_synced_at");
  const firstSeen = new Map<string, string>();
  for (const r of (existData ?? []) as any[]) firstSeen.set(String(r.contact_id), r.first_synced_at);
  for (const rec of records) { const f = firstSeen.get(rec.contact_id); if (f) rec.first_synced_at = f; }

  // 4) Upsert (never truncate) on contact_id, in chunks.
  const CHUNK = 100;
  for (let i = 0; i < records.length; i += CHUNK) {
    const slice = records.slice(i, i + CHUNK);
    const { error } = await db.from("ac_ad_leads_tagging").upsert(slice, { onConflict: "contact_id" });
    if (error) s.errors.push(`upsert @${i}: ${error.message}`); else s.upserted += slice.length;
  }

  s.won_value_total = Math.round(s.won_value_total * 100) / 100;
  console.log("ac-ad-leads-sync summary:", JSON.stringify(s));
  return s;
}

Deno.serve(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const tagId = (params.get("tag") && /^\d+$/.test(params.get("tag")!)) ? params.get("tag")! : TAG_ID;
  const sync = params.get("sync") === "1" || params.get("sync") === "true";
  if (sync) { const summary = await run(tagId); return json({ mode: "sync", ...summary }); }
  const work = run(tagId).catch((e) => console.error("run failed:", e instanceof Error ? e.message : String(e)));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  return json({ mode: "async", status: "accepted", tag_id: tagId }, 202);
});
