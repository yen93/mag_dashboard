// sales-deals-sync — fills public.sales_liv_deals, the cache table behind the
// dashboard Sales page (GET /api/sales/deals). Runs Mon–Fri 06:00 PH via
// pg_cron. Mirrors the buyer-sheet-sync pattern: one wide cache table, UPSERTed
// (never truncated) on deal_id, so the Node/Express dashboard does a plain
// SELECT and makes zero ActiveCampaign calls at request time.
//
// Scope: the LIV pipeline "Keynotes // Workshops // Immersive" =
// activecampaign_deals."group" = '3', deals CREATED in 2026.
//
// 10 base columns come from the Supabase AC mirror (date, account, contact,
// replied-from-stage, status, demo date, proposal sent, owner id). The other 6
// enriched columns (lead type, job title, last note + date, owner NAME, Magalog)
// live only in ActiveCampaign and are filled by the per-deal enrichment pass.
// Enrichment is best-effort and incremental: bounded by ?limit=N and a
// wall-clock budget, it drains new/changed deals over successive daily runs.
//
// Full source also versioned in the dashboard repo at
// supabase/functions/sales-deals-sync/index.ts.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AC_API_URL = (Deno.env.get("AC_API_URL") ?? "").replace(/\/+$/, "");
const AC_API_TOKEN = Deno.env.get("AC_API_TOKEN") ?? "";
const MAX_ENRICH_ATTEMPTS = parseInt(Deno.env.get("MAX_ENRICH_ATTEMPTS") ?? "2", 10);

const DEFAULT_LIMIT = 50;
const WALL_CLOCK_MS = parseInt(Deno.env.get("WALL_CLOCK_MS") ?? "150000", 10);
const PER_DEAL_RESERVE_MS = parseInt(Deno.env.get("PER_DEAL_RESERVE_MS") ?? "4000", 10);

const GROUP_ID = "3";
const YEAR_START = "2026-01-01";
const YEAR_END = "2027-01-01";

// "Replied back to us" = Yes for any reply or downstream stage; No only for
// 71 (CONTACT MADE – NO REPLY) and any pre-contact/foreign/unknown stage.
const YES_STAGES = new Set(["70", "69", "58", "59", "15", "121", "113", "12"]);

// AC CONTACT custom field ids: 39 = "Inbound/Outbound Check" (lead type),
// 35 = "Magalog sent?". Used as a fallback when there is no equivalent
// DEAL-level field resolved from dealCustomFieldMeta.
const LEADTYPE_CONTACT_FIELD = "39";
const MAGALOG_CONTACT_FIELD = "35";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface DealRow {
  id: string; title: string | null; account: string | null; contact: string | null;
  owner: string | null; stage: string | null; status: number | null;
  cdate: string | null; mdate: string | null;
}
interface BaseRecord {
  deal_id: string; date_created: string | null; account: string | null; account_id: string | null;
  contact: string | null; contact_id: string | null; replied: string; status: string;
  demo_date: string | null; proposal_sent: string | null; owner: string | null;
  deal_mdate: string | null; deal_group: string; in_scope: boolean;
  base_synced_at: string; updated_at: string;
  enriched_at?: string | null; enrichment_attempts?: number;
}

// AC multi-select values are wrapped/joined with "||"; normalise to a plain string.
const cleanValue = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).replace(/\|+/g, ", ").replace(/^,\s*|,\s*$/g, "").trim();
  return s || null;
};
const stripHtml = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return s || null;
};
const fullName = (f?: string | null, l?: string | null): string | null => {
  const n = [f ?? "", l ?? ""].map((x) => x.trim()).filter(Boolean).join(" ").trim();
  return n || null;
};
const statusLabel = (s: number | null): string =>
  s === 0 ? "open" : s === 1 ? "won" : s === 2 ? "lost" : "other";

function pickLatestNote(notes: any[]): any | null {
  if (!Array.isArray(notes) || !notes.length) return null;
  return notes
    .filter((n) => n && n.note != null)
    .sort((a, b) => new Date(b.cdate || b.mdate || 0).getTime() - new Date(a.cdate || a.mdate || 0).getTime())[0] || null;
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
// Paginate an AC collection by offset. `key` is the array property on the body.
async function acPaginate(path: string, key: string, params: Record<string, string> = {}, max = 20000): Promise<any[]> {
  const out: any[] = [];
  const pageSize = 100;
  for (let offset = 0; offset < max; offset += pageSize) {
    const qs = new URLSearchParams({ ...params, limit: String(pageSize), offset: String(offset) }).toString();
    const d = await acGet(`${path}?${qs}`);
    const arr = d && Array.isArray(d[key]) ? d[key] : [];
    out.push(...arr);
    if (arr.length < pageSize) break;
  }
  return out;
}

interface FieldIds { leadType: string | null; jobTitle: string | null; magalog: string | null; }
function matchFields(meta: any[]): FieldIds {
  const out: FieldIds = { leadType: null, jobTitle: null, magalog: null };
  for (const m of meta) {
    const label = String(m.fieldLabel || m.label || "").toLowerCase();
    const id = String(m.id);
    if (!out.leadType && (label.includes("inbound") || label.includes("outbound"))) out.leadType = id;
    if (!out.jobTitle && label.includes("job title")) out.jobTitle = id;
    if (!out.magalog && label.includes("magalog")) out.magalog = id;
  }
  return out;
}

async function fetchByIds<T extends { id: string }>(db: SupabaseClient, table: string, cols: string, ids: string[]): Promise<Map<string, T>> {
  const map = new Map<string, T>();
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  const CHUNK = 200;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const { data, error } = await db.from(table).select(cols).in("id", slice);
    if (error) { console.warn(`${table} lookup: ${error.message}`); continue; }
    for (const row of (data ?? []) as unknown as T[]) map.set(String(row.id), row);
  }
  return map;
}

// Latest ac_custom_fields (demo_date / proposal_sent) per deal_id.
async function fetchCustomFields(db: SupabaseClient, dealIds: string[]): Promise<Map<string, { demo_date: string | null; proposal_sent: string | null }>> {
  const map = new Map<string, { demo_date: string | null; proposal_sent: string | null; created_at: string | null }>();
  const uniq = Array.from(new Set(dealIds.filter(Boolean)));
  const CHUNK = 200;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const { data, error } = await db.from("ac_custom_fields")
      .select("deal_id, demo_date, proposal_sent, created_at").in("deal_id", slice);
    if (error) { console.warn(`ac_custom_fields lookup: ${error.message}`); continue; }
    for (const r of (data ?? []) as any[]) {
      const k = String(r.deal_id);
      const prev = map.get(k);
      if (!prev || String(r.created_at ?? "") > String(prev.created_at ?? "")) map.set(k, r);
    }
  }
  const out = new Map<string, { demo_date: string | null; proposal_sent: string | null }>();
  for (const [k, v] of map) out.set(k, { demo_date: v.demo_date ?? null, proposal_sent: v.proposal_sent ?? null });
  return out;
}

type Summary = {
  fn: string; limit: number; scope_deals: number; base_upserted: number;
  reconciled_out_of_scope: number; candidates: number; ac_enriched: number;
  stopped_early: boolean; errors: string[];
};

async function run(limit: number): Promise<Summary> {
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const started = Date.now();
  const now = () => new Date().toISOString();
  const s: Summary = { fn: "sales-deals-sync", limit, scope_deals: 0, base_upserted: 0, reconciled_out_of_scope: 0, candidates: 0, ac_enriched: 0, stopped_early: false, errors: [] };

  // 1. In-scope deals from the AC mirror (group 3, created in 2026).
  const { data: dealData, error: dealErr } = await db.from("activecampaign_deals")
    .select("id, title, account, contact, owner, stage, status, cdate, mdate")
    .eq("group", GROUP_ID).gte("cdate", YEAR_START).lt("cdate", YEAR_END);
  if (dealErr) { s.errors.push(`scope deals: ${dealErr.message}`); return s; }
  const dealMap = new Map<string, DealRow>();
  for (const r of (dealData ?? []) as unknown as DealRow[]) dealMap.set(String(r.id), r);
  const deals = Array.from(dealMap.values());
  s.scope_deals = deals.length;
  if (!deals.length) return s;

  // 2. Resolve related entities.
  const accounts = await fetchByIds<{ id: string; name: string | null }>(db, "activecampaign_accounts", "id, name", deals.map((d) => d.account ?? "").filter(Boolean));
  const contacts = await fetchByIds<{ id: string; firstName: string | null; lastName: string | null }>(db, "activecampaign_contacts", "id, firstName, lastName", deals.map((d) => d.contact ?? "").filter(Boolean));
  const customFields = await fetchCustomFields(db, deals.map((d) => String(d.id)));

  // Owner id -> name (one AC call for all deals). Best-effort.
  const ownerMap: Record<string, string> = {};
  if (AC_API_URL && AC_API_TOKEN) {
    const users = await acPaginate("users", "users", {}, 2000);
    for (const u of users) ownerMap[String(u.id)] = fullName(u.firstName, u.lastName) || u.username || u.email || String(u.id);
  }

  // 3. Existing cache rows (for change-detection + reconciliation).
  const { data: existData } = await db.from("sales_liv_deals").select("deal_id, deal_mdate, enriched_at, enrichment_attempts");
  const existing = new Map<string, { deal_mdate: string | null; enriched_at: string | null; enrichment_attempts: number | null }>();
  for (const r of (existData ?? []) as any[]) existing.set(String(r.deal_id), r);

  // 4. Build + upsert base records (never truncate).
  const baseRecords: BaseRecord[] = deals.map((d) => {
    const acc = d.account ? accounts.get(String(d.account)) : undefined;
    const con = d.contact ? contacts.get(String(d.contact)) : undefined;
    const cf = customFields.get(String(d.id));
    const account = cleanValue(acc?.name) || cleanValue((d.title ?? "").split("//")[0]);
    const prev = existing.get(String(d.id));
    const changed = !prev || String(prev.deal_mdate ?? "") !== String(d.mdate ?? "");
    const rec: BaseRecord = {
      deal_id: String(d.id), date_created: d.cdate, account, account_id: d.account ? String(d.account) : null,
      contact: fullName(con?.firstName, con?.lastName), contact_id: d.contact ? String(d.contact) : null,
      replied: d.stage != null && YES_STAGES.has(String(d.stage)) ? "Yes" : "No",
      status: statusLabel(d.status), demo_date: cf?.demo_date ?? null, proposal_sent: cf?.proposal_sent ?? null,
      owner: d.owner ? (ownerMap[String(d.owner)] ?? String(d.owner)) : null,
      deal_mdate: d.mdate, deal_group: GROUP_ID, in_scope: true, base_synced_at: now(), updated_at: now(),
    };
    // Re-enrich from scratch when the deal changed (or is new).
    if (changed) { rec.enriched_at = null; rec.enrichment_attempts = 0; }
    return rec;
  });
  const CHUNK = 100;
  for (let i = 0; i < baseRecords.length; i += CHUNK) {
    const slice = baseRecords.slice(i, i + CHUNK);
    const { error } = await db.from("sales_liv_deals").upsert(slice, { onConflict: "deal_id" });
    if (error) s.errors.push(`base upsert: ${error.message}`); else s.base_upserted += slice.length;
  }

  // 5. Reconcile cache rows whose deal left scope — tag in_scope=false, never delete.
  const scopeIds = new Set(deals.map((d) => String(d.id)));
  const { data: allCache } = await db.from("sales_liv_deals").select("deal_id, in_scope");
  const dropped = ((allCache ?? []) as any[]).filter((r) => !scopeIds.has(String(r.deal_id)) && r.in_scope !== false);
  for (const r of dropped) {
    const { error } = await db.from("sales_liv_deals").update({ in_scope: false, updated_at: now() }).eq("deal_id", r.deal_id);
    if (error) s.errors.push(`reconcile ${r.deal_id}: ${error.message}`); else s.reconciled_out_of_scope++;
  }

  // 6. Enrichment pass (bounded): fill the 6 AC-only columns for new/changed rows.
  if (!AC_API_URL || !AC_API_TOKEN) { console.log("sales-deals-sync (no AC creds):", JSON.stringify(s)); return s; }
  const candidates = baseRecords
    .filter((r) => {
      const prev = existing.get(r.deal_id);
      const enrichedAt = r.enriched_at === null ? null : prev?.enriched_at ?? null; // null after a change reset
      const attempts = r.enrichment_attempts ?? prev?.enrichment_attempts ?? 0;
      return !enrichedAt && attempts < MAX_ENRICH_ATTEMPTS;
    })
    .sort((a, b) => String(b.deal_mdate ?? "").localeCompare(String(a.deal_mdate ?? "")))
    .slice(0, limit);
  s.candidates = candidates.length;
  if (!candidates.length) { console.log("sales-deals-sync summary:", JSON.stringify(s)); return s; }

  const meta = await acPaginate("dealCustomFieldMeta", "dealCustomFieldMeta", {}, 2000);
  const fieldId = matchFields(meta);

  for (const rec of candidates) {
    if (Date.now() - started > WALL_CLOCK_MS - PER_DEAL_RESERVE_MS) { s.stopped_early = true; break; }
    const update: Record<string, unknown> = { updated_at: now() };
    try {
      // Deal-level custom fields: lead type / job title / Magalog.
      const cdRes = await acGet(`deals/${rec.deal_id}/dealCustomFieldData?limit=100`);
      const cfd = cdRes && Array.isArray(cdRes.dealCustomFieldData) ? cdRes.dealCustomFieldData : [];
      const byField: Record<string, unknown> = {};
      for (const v of cfd) { const k = String(v.customFieldId ?? v.dealCustomFieldMetumId ?? v.custom_field_id ?? ""); if (k) byField[k] = v.fieldValue; }
      let leadType = fieldId.leadType ? cleanValue(byField[fieldId.leadType]) : null;
      let jobTitle = fieldId.jobTitle ? cleanValue(byField[fieldId.jobTitle]) : null;
      let magalog = fieldId.magalog ? cleanValue(byField[fieldId.magalog]) : null;

      // Latest note.
      const nRes = await acGet(`deals/${rec.deal_id}/notes`);
      const latest = pickLatestNote(nRes && Array.isArray(nRes.notes) ? nRes.notes : []);
      if (latest) { update.last_note = stripHtml(latest.note); update.last_note_date = latest.cdate || latest.mdate || null; }

      // Contact-level fallbacks for lead type / Magalog, and job title via accountContacts.
      if (rec.contact_id) {
        const fvRes = await acGet(`contacts/${rec.contact_id}/fieldValues?limit=100`);
        const fvals = fvRes && Array.isArray(fvRes.fieldValues) ? fvRes.fieldValues : [];
        const byFieldC: Record<string, unknown> = {};
        for (const fv of fvals) byFieldC[String(fv.field)] = fv.value;
        if (leadType == null) leadType = cleanValue(byFieldC[LEADTYPE_CONTACT_FIELD]);
        if (magalog == null) magalog = cleanValue(byFieldC[MAGALOG_CONTACT_FIELD]);

        if (jobTitle == null) {
          const acRes = await acGet(`contacts/${rec.contact_id}/accountContacts`);
          const links = acRes && Array.isArray(acRes.accountContacts) ? acRes.accountContacts : [];
          let anyTitle: string | null = null;
          for (const l of links) {
            const t = cleanValue(l.jobTitle); if (!t) continue;
            if (rec.account_id && String(l.account) === String(rec.account_id)) { jobTitle = t; break; }
            if (!anyTitle) anyTitle = t;
          }
          if (jobTitle == null) jobTitle = anyTitle;
        }
      }

      if (leadType != null) update.lead_type = leadType;
      if (jobTitle != null) update.job_title = jobTitle;
      if (magalog != null) update.magalog_sent = magalog;
      update.enriched_at = now();
      s.ac_enriched++;

      const { error } = await db.from("sales_liv_deals").update(update).eq("deal_id", rec.deal_id);
      if (error) s.errors.push(`${rec.deal_id} update: ${error.message}`);
    } catch (err) {
      const prevAttempts = existing.get(rec.deal_id)?.enrichment_attempts ?? 0;
      await db.from("sales_liv_deals").update({ enrichment_attempts: prevAttempts + 1, updated_at: now() }).eq("deal_id", rec.deal_id);
      s.errors.push(`${rec.deal_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("sales-deals-sync summary:", JSON.stringify(s));
  return s;
}

Deno.serve(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const limitParam = params.get("limit");
  let limit = limitParam ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  const sync = params.get("sync") === "1" || params.get("sync") === "true";
  if (sync) { const summary = await run(limit); return json({ mode: "sync", ...summary }); }
  const work = run(limit).catch((e) => console.error("run failed:", e instanceof Error ? e.message : String(e)));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  return json({ mode: "async", status: "accepted", limit }, 202);
});
