// buyer-sheet-sync
// ---------------------------------------------------------------------------
// Materialises the "MAG Buyer Analysis" sheet (tabs 2026/2027) into
// public.mag_buyer_sheet from ActiveCampaign (+ OpenAI web search), so the
// dashboard page can read a single pre-computed table.
//
// Scope: every WON deal (activecampaign_deals.status = 1), all pipelines.
//
// Per run:
//   1. BASE (cheap, no external calls): read won deals + their account/contact
//      from the Supabase AC mirror; parse program + event date from the deal
//      title; upsert base columns for ALL won deals. New/changed deals (by AC
//      mdate) have their enrichment reset so they get re-enriched.
//   2. AC enrichment (bounded by ?limit + wall clock): per candidate deal, pull
//      Event Date (#7), Audience size (#4), Deal Source (#6) from
//      dealCustomFieldData; Job Title from accountContacts; Industry from the
//      contact's custom field values.
//   3. OpenAI enrichment: one web-search-grounded call per candidate for
//      Business Size + Seniority + Key Decision Maker. Returns null when unsure
//      (never guesses). KDM defaults to the primary contact when no distinct,
//      verified decision maker is found.
//
// Read-only against AC + OpenAI; only writes public.mag_buyer_sheet.
//
// Invoke: POST/GET ?limit=N (default 25 enrichments) ?sync=1 (inline + summary).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, AC_API_URL,
//          AC_API_TOKEN; optional OPENAI_MODEL, MAX_ENRICH_ATTEMPTS.
// Deploy: Supabase MCP deploy_edge_function, verify_jwt:false.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AC_API_URL = (Deno.env.get("AC_API_URL") ?? "").replace(/\/+$/, "");
const AC_API_TOKEN = Deno.env.get("AC_API_TOKEN") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
// Web-search tool context size: "low" is the cheapest tier (fewer retrieved
// tokens + lower tool fee). Override with OPENAI_SEARCH_CONTEXT if needed.
const OPENAI_SEARCH_CONTEXT = Deno.env.get("OPENAI_SEARCH_CONTEXT") ?? "low";
const MAX_ENRICH_ATTEMPTS = parseInt(Deno.env.get("MAX_ENRICH_ATTEMPTS") ?? "2", 10);

const DEFAULT_LIMIT = 25;
const WALL_CLOCK_MS = parseInt(Deno.env.get("WALL_CLOCK_MS") ?? "150000", 10);
const OPENAI_CALL_RESERVE_MS = parseInt(Deno.env.get("OPENAI_CALL_RESERVE_MS") ?? "25000", 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ---- types ----------------------------------------------------------------
interface DealRow {
  id: string;
  title: string | null;
  value: number | null;
  currency: string | null;
  account: string | null;
  contact: string | null;
  mdate: string | null;
}
// Base columns are deterministic from the mirror/title and safe to refresh every
// run. event_date / year / direct_indirect are deliberately NOT here — they are
// AC-authoritative (title only as a fallback) and owned by enrichment, so the
// daily base refresh must not clobber them.
interface BaseRecord {
  deal_id: string;
  company: string | null;
  program_delivered: string | null;
  value_aud: number | null;
  currency: string | null;
  ipoc_name: string | null;
  ipoc_email: string | null;
  deal_title: string | null;
  deal_mdate: string | null;
  deal_status: string;     // 'won' while in the won set (re-healed below)
  lost_at: string | null;  // cleared here; set by reconcile when a deal leaves "won"
  base_synced_at: string;
  updated_at: string;
  // reset enrichment for new/changed deals
  enriched_at?: string | null;
  enrichment_attempts?: number;
}

// ---- small helpers --------------------------------------------------------
const clean = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).replace(/\|+/g, ", ").replace(/^[,\s]+|[,\s]+$/g, "").replace(/\s+/g, " ").trim();
  return s || null;
};
const fullName = (f?: string | null, l?: string | null): string | null => {
  // AC data sometimes stuffs a title into lastName, e.g. "Edwards | Managing Director APAC".
  const last = (l ?? "").split("|")[0].trim();
  const n = [f ?? "", last].filter(Boolean).join(" ").trim();
  return n || null;
};

// Program taxonomy — extends server/lib/sql.js SOURCE_BUCKET with the buyer
// sheet's extra labels (Workshop, MAG Offsite, The Tailor, Teambuilding).
function programFromTitle(title: string | null): string | null {
  const s = (title ?? "").toLowerCase();
  if (!s) return null;
  if (s.includes("post") && s.includes("keynote")) return "Post-keynote";
  if (s.includes("immersive") || s.includes("uncharted ice")) return "Immersive";
  if (s.includes("keynote")) return "Keynote";
  if (s.includes("offsite")) return "MAG Offsite";
  if (s.includes("workshop")) return "Workshop";
  if (s.includes("teambuilding") || s.includes("team building")) return "Teambuilding";
  if (s.includes("exec x") || s.includes("executive x")) return "Exec X";
  if (s.includes("tailor")) return "The Tailor";
  return "Other";
}

// Deal titles frequently end with the event date as free text, e.g.
// "Sydney Water // Workshop // 28 September 2026". Parse a trailing date-ish
// segment as a fallback when the AC Event Date custom field is empty.
function eventDateFromTitle(title: string | null): string | null {
  if (!title) return null;
  const segs = title.split("//").map((p) => p.trim()).filter(Boolean);
  for (let i = segs.length - 1; i >= 0 && i >= segs.length - 2; i--) {
    const seg = segs[i];
    // Require an explicit 20xx year in the segment, otherwise Date() invents
    // wild years (e.g. "21 Jul" -> 2029) from ambiguous fragments.
    if (!/\b20\d{2}\b/.test(seg)) continue;
    const d = new Date(seg);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 2015 && d.getFullYear() <= 2100) {
      return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

// Known indirect channels (PCO / bureau / events companies) seen in deal titles.
const BUREAUS = [
  "platinum speakers", "vistage", "claxton", "saxton", "icmi", "ovations",
  "celebrity speakers", "the tailor", "tailor", "ode management", "keynote entertainment",
  "great expectation", "speakers bureau", "harry m miller", "the fordham company",
];
function directIndirectFromTitle(title: string | null): string | null {
  const first = (title ?? "").split("//")[0].toLowerCase();
  if (!first) return null;
  return BUREAUS.some((b) => first.includes(b)) ? "Indirect" : "Direct";
}

function seniorityFromTitle(title: string | null): string | null {
  const s = (title ?? "").toLowerCase();
  if (!s) return null;
  if (/\b(ceo|cfo|coo|cto|cmo|chro|cio|chief|president|founder|owner|managing director|partner|board|vp|vice president|head of|general manager|\bgm\b|director)\b/.test(s)) {
    return "C-Suite/Senior Mgmt.";
  }
  if (/\b(manager|lead|principal|coordinator|supervisor|advisor|consultant|specialist|officer)\b/.test(s)) {
    return "Middle Mgmt.";
  }
  return "Others";
}

const yearOf = (iso: string | null): number | null =>
  iso ? Number(iso.slice(0, 4)) : null;

// ---- ActiveCampaign -------------------------------------------------------
const acHeaders = { "Api-Token": AC_API_TOKEN, "Content-Type": "application/json" };

async function acGet(path: string): Promise<any | null> {
  try {
    const r = await fetch(`${AC_API_URL}/api/3/${path}`, { headers: acHeaders });
    if (!r.ok) {
      if (r.status === 429) { await sleep(1500); return acGet(path); }
      console.warn(`AC ${r.status} for ${path}`);
      return null;
    }
    return await r.json();
  } catch (err) {
    console.warn(`AC fetch failed for ${path}: ${err}`);
    return null;
  }
}

interface FieldIds { eventDate: string | null; audience: string | null; dealSource: string | null; }
async function resolveDealFieldIds(): Promise<FieldIds> {
  const out: FieldIds = { eventDate: null, audience: null, dealSource: null };
  const d = await acGet("dealCustomFieldMeta?limit=100");
  const meta = d && Array.isArray(d.dealCustomFieldMeta) ? d.dealCustomFieldMeta : [];
  for (const m of meta) {
    const label = String(m.fieldLabel || "").toLowerCase();
    const id = String(m.id);
    if (!out.eventDate && label.includes("event date")) out.eventDate = id;
    if (!out.audience && (label.includes("pax") || label.includes("audience"))) out.audience = id;
    if (!out.dealSource && label.includes("deal source")) out.dealSource = id;
  }
  return out;
}

async function resolveContactIndustryFieldId(): Promise<string | null> {
  const d = await acGet("fields?limit=100");
  const fields = d && Array.isArray(d.fields) ? d.fields : [];
  const hit = fields.find((f: any) => String(f.title || "").trim().toLowerCase() === "industry");
  return hit ? String(hit.id) : null;
}

function mapDealSource(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.startsWith("indirect")) return "Indirect";
  if (s.startsWith("direct")) return "Direct";
  return clean(raw);
}

async function acDealCustomFields(dealId: string, ids: FieldIds) {
  const out = { eventDate: null as string | null, audience: null as string | null, dealSource: null as string | null };
  const d = await acGet(`deals/${dealId}/dealCustomFieldData?limit=100`);
  const list = d && Array.isArray(d.dealCustomFieldData) ? d.dealCustomFieldData : [];
  const byField: Record<string, unknown> = {};
  for (const v of list) {
    const k = String(v.customFieldId ?? v.dealCustomFieldMetumId ?? v.custom_field_id ?? "");
    if (k) byField[k] = v.fieldValue;
  }
  if (ids.eventDate && byField[ids.eventDate]) {
    const dt = new Date(String(byField[ids.eventDate]));
    if (!isNaN(dt.getTime())) out.eventDate = dt.toISOString().slice(0, 10);
  }
  if (ids.audience) out.audience = clean(byField[ids.audience]);
  if (ids.dealSource) out.dealSource = mapDealSource(clean(byField[ids.dealSource]));
  return out;
}

async function acJobTitle(contactId: string, accountId: string | null): Promise<string | null> {
  const d = await acGet(`contacts/${contactId}/accountContacts`);
  const list = d && Array.isArray(d.accountContacts) ? d.accountContacts : [];
  let anyTitle: string | null = null;
  for (const a of list) {
    const t = clean(a.jobTitle);
    if (!t) continue;
    if (accountId && String(a.account) === String(accountId)) return t;
    if (!anyTitle) anyTitle = t;
  }
  return anyTitle;
}

async function acIndustry(contactId: string, industryFieldId: string | null): Promise<string | null> {
  if (!industryFieldId) return null;
  const d = await acGet(`contacts/${contactId}/fieldValues?limit=100`);
  const list = d && Array.isArray(d.fieldValues) ? d.fieldValues : [];
  const hit = list.find((fv: any) => String(fv.field) === industryFieldId);
  return hit ? clean(hit.value) : null;
}

// ---- OpenAI web-search enrichment ----------------------------------------
function openaiExtractText(d: unknown): string {
  const doc = d as { output_text?: unknown; output?: unknown };
  if (typeof doc?.output_text === "string" && doc.output_text.trim()) return doc.output_text;
  const parts: string[] = [];
  const out = Array.isArray(doc?.output) ? doc.output : [];
  for (const item of out as Record<string, unknown>[]) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content as Record<string, unknown>[]) {
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n");
}

interface Enrichment {
  business_size: string | null;
  ipoc_seniority: string | null;
  kdm_name: string | null;
  kdm_job_title: string | null;
  kdm_seniority: string | null;
  source: string | null;
  confidence: string;
}
function parseEnrichmentJson(text: string): Enrichment {
  const fail: Enrichment = { business_size: null, ipoc_seniority: null, kdm_name: null, kdm_job_title: null, kdm_seniority: null, source: null, confidence: "low" };
  if (!text) return fail;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return fail;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const str = (x: unknown) => (x == null || String(x).trim() === "" || String(x).toLowerCase() === "null" ? null : String(x).trim());
    return {
      business_size: str(o.business_size),
      ipoc_seniority: str(o.ipoc_seniority),
      kdm_name: str(o.kdm_name),
      kdm_job_title: str(o.kdm_job_title),
      kdm_seniority: str(o.kdm_seniority),
      source: str(o.source_url),
      confidence: str(o.confidence)?.toLowerCase() ?? "low",
    };
  } catch {
    return fail;
  }
}

async function openaiEnrich(company: string | null, ipocName: string | null, ipocTitle: string | null): Promise<Enrichment | "retry"> {
  if (!OPENAI_API_KEY) return "retry";
  const input =
    `You are enriching a B2B buyer record using web search. Only state facts you can ` +
    `verify from reputable public sources (the company's website, LinkedIn, press ` +
    `releases, reputable directories). Never guess; return null for anything you ` +
    `cannot verify.\n\n` +
    `Company: ${company || "(unknown)"}\n` +
    `Known contact at the company: ${ipocName || "(unknown)"}${ipocTitle ? `, ${ipocTitle}` : ""}\n\n` +
    `Find:\n` +
    `1. business_size: the company's approximate headcount as a band (e.g. "11-50 employees", "5,000-10,000 employees"). null if unknown.\n` +
    `2. ipoc_seniority: seniority of the known contact, ONE of exactly "C-Suite/Senior Mgmt.", "Middle Mgmt.", or "Others". null if the contact/title is unknown.\n` +
    `3. The likely KEY DECISION MAKER for booking a corporate keynote / leadership / offsite program at this company (kdm_name, kdm_job_title, and kdm_seniority as one of the same three values). If the known contact above is themselves the decision maker, repeat them. null for any you cannot verify.\n\n` +
    `Respond with ONLY a compact JSON object and nothing else:\n` +
    `{"business_size": <string|null>, "ipoc_seniority": <string|null>, "kdm_name": <string|null>, "kdm_job_title": <string|null>, "kdm_seniority": <string|null>, "source_url": <string|null>, "confidence": "high"|"medium"|"low"}`;
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: OPENAI_MODEL, tools: [{ type: "web_search_preview", search_context_size: OPENAI_SEARCH_CONTEXT }], input }),
    });
    if (!r.ok) {
      console.warn(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return "retry";
    }
    const d = await r.json();
    return parseEnrichmentJson(openaiExtractText(d));
  } catch (err) {
    console.warn(`OpenAI fetch failed: ${err}`);
    return "retry";
  }
}

// Normalise a free-text seniority to the sheet's three allowed values.
function bucketSeniority(v: string | null): string | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (s.includes("c-suite") || s.includes("c suite") || s.includes("senior")) return "C-Suite/Senior Mgmt.";
  if (s.includes("middle")) return "Middle Mgmt.";
  if (s.includes("other")) return "Others";
  return seniorityFromTitle(v);
}

// ---- batched lookups in the Supabase AC mirror ---------------------------
async function fetchByIds<T extends { id: string }>(
  db: SupabaseClient, table: string, cols: string, ids: string[],
): Promise<Map<string, T>> {
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

// ---- main run -------------------------------------------------------------
type Summary = {
  fn: string; model: string; search_context: string; limit: number; won_deals: number; base_upserted: number;
  reset_for_reenrich: number; reconciled_non_won: number; candidates: number; ac_enriched: number;
  openai_enriched: number; openai_miss: number; stopped_early: boolean; errors: string[];
};

async function run(limit: number): Promise<Summary> {
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const started = Date.now();
  const now = () => new Date().toISOString();
  const s: Summary = {
    fn: "buyer-sheet-sync", model: OPENAI_MODEL, search_context: OPENAI_SEARCH_CONTEXT,
    limit, won_deals: 0, base_upserted: 0, reset_for_reenrich: 0,
    reconciled_non_won: 0, candidates: 0, ac_enriched: 0, openai_enriched: 0, openai_miss: 0,
    stopped_early: false, errors: [],
  };

  // 1. Won deals from the AC mirror.
  const { data: dealData, error: dealErr } = await db
    .from("activecampaign_deals")
    .select("id, title, value, currency, account, contact, mdate")
    .eq("status", 1);
  if (dealErr) { s.errors.push(`won deals: ${dealErr.message}`); return s; }
  // Dedupe by id — the AC mirror occasionally holds duplicate deal rows, which
  // would otherwise make a single upsert "affect a row a second time".
  const dealMap = new Map<string, DealRow>();
  for (const r of (dealData ?? []) as unknown as DealRow[]) dealMap.set(String(r.id), r);
  const deals = Array.from(dealMap.values());
  s.won_deals = deals.length;
  if (!deals.length) return s;

  // Resolve account names + contact identities in bulk.
  const accounts = await fetchByIds<{ id: string; name: string | null }>(
    db, "activecampaign_accounts", "id, name", deals.map((d) => d.account ?? "").filter(Boolean));
  const contacts = await fetchByIds<{ id: string; firstName: string | null; lastName: string | null; email: string | null }>(
    db, "activecampaign_contacts", "id, firstName, lastName, email", deals.map((d) => d.contact ?? "").filter(Boolean));

  // Existing rows (to detect AC-side changes and skip already-enriched deals).
  const { data: existData } = await db
    .from("mag_buyer_sheet")
    .select("deal_id, deal_mdate, enriched_at, enrichment_attempts");
  const existing = new Map<string, { deal_mdate: string | null; enriched_at: string | null; enrichment_attempts: number | null }>();
  for (const r of (existData ?? []) as any[]) existing.set(String(r.deal_id), r);

  // 2. Build + upsert base rows for all won deals.
  const baseRecords: BaseRecord[] = [];
  for (const d of deals) {
    const acc = d.account ? accounts.get(String(d.account)) : undefined;
    const con = d.contact ? contacts.get(String(d.contact)) : undefined;
    const company = clean(acc?.name) || clean((d.title ?? "").split("//")[0]);
    const prev = existing.get(String(d.id));
    const changed = !prev || String(prev.deal_mdate ?? "") !== String(d.mdate ?? "");
    const rec: BaseRecord = {
      deal_id: String(d.id),
      company,
      program_delivered: programFromTitle(d.title),
      value_aud: d.value != null ? Number(d.value) / 100 : null,
      currency: d.currency ? d.currency.toLowerCase() : null,
      ipoc_name: fullName(con?.firstName, con?.lastName),
      ipoc_email: clean(con?.email),
      deal_title: d.title,
      deal_mdate: d.mdate,
      deal_status: "won",   // currently in the won set; re-heals a previously-lost deal
      lost_at: null,
      base_synced_at: now(),
      updated_at: now(),
    };
    if (changed) { rec.enriched_at = null; rec.enrichment_attempts = 0; s.reset_for_reenrich++; }
    baseRecords.push(rec);
  }
  const CHUNK = 100;
  for (let i = 0; i < baseRecords.length; i += CHUNK) {
    const slice = baseRecords.slice(i, i + CHUNK);
    const { error } = await db.from("mag_buyer_sheet").upsert(slice, { onConflict: "deal_id" });
    if (error) s.errors.push(`base upsert: ${error.message}`);
    else s.base_upserted += slice.length;
  }

  // 2b. Reconcile cache rows whose deal is no longer WON. A buyer can cancel
  //     (won -> lost), re-open (won -> open) or be deleted in AC. We don't drop
  //     the row — we tag deal_status to the deal's current mirror status and
  //     stamp lost_at the first time it becomes 'lost'. (Re-won deals are
  //     re-healed to 'won' with lost_at cleared by the base upsert above.)
  const wonIds = new Set(deals.map((d) => String(d.id)));
  const { data: cacheRows } = await db
    .from("mag_buyer_sheet")
    .select("deal_id, deal_status, lost_at");
  const dropped = ((cacheRows ?? []) as any[]).filter((r) => !wonIds.has(String(r.deal_id)));
  if (dropped.length) {
    const statusById = await fetchByIds<{ id: string; status: number | null }>(
      db, "activecampaign_deals", "id, status", dropped.map((r) => String(r.deal_id)));
    for (const r of dropped) {
      const st = statusById.get(String(r.deal_id))?.status;
      const label = st === 2 ? "lost" : st === 0 ? "open" : st == null ? "removed" : "other";
      const upd: Record<string, unknown> = { deal_status: label, updated_at: now() };
      if (label === "lost" && !r.lost_at) upd.lost_at = now();
      const { error } = await db.from("mag_buyer_sheet").update(upd).eq("deal_id", r.deal_id);
      if (error) s.errors.push(`reconcile ${r.deal_id}: ${error.message}`);
      else s.reconciled_non_won++;
    }
  }

  // 3. Candidate deals needing enrichment.
  const dealById = new Map(deals.map((d) => [String(d.id), d]));
  const candidates = baseRecords
    .filter((r) => {
      const prev = existing.get(r.deal_id);
      const alreadyEnriched = prev?.enriched_at && !(r.enriched_at === null); // reset above => re-enrich
      const attempts = r.enrichment_attempts ?? prev?.enrichment_attempts ?? 0;
      return !alreadyEnriched && attempts < MAX_ENRICH_ATTEMPTS;
    })
    // Most-recently-modified deals first, so new/changed wins enrich soonest.
    .sort((a, b) => String(dealById.get(b.deal_id)?.mdate ?? "").localeCompare(String(dealById.get(a.deal_id)?.mdate ?? "")))
    .slice(0, limit);
  s.candidates = candidates.length;
  if (!candidates.length) return s;

  const fieldIds = await resolveDealFieldIds();
  const industryFieldId = await resolveContactIndustryFieldId();

  for (const rec of candidates) {
    if (Date.now() - started > WALL_CLOCK_MS - OPENAI_CALL_RESERVE_MS) { s.stopped_early = true; break; }
    const d = dealById.get(rec.deal_id)!;
    const update: Record<string, unknown> = { updated_at: now() };
    try {
      // -- AC enrichment (AC custom field first, deal-title text as fallback) --
      const cf = await acDealCustomFields(rec.deal_id, fieldIds);
      const eventDate = cf.eventDate ?? eventDateFromTitle(d.title);
      if (eventDate) { update.event_date = eventDate; update.year = yearOf(eventDate); }
      if (cf.audience) update.audience_size = cf.audience;
      const dealSource = cf.dealSource ?? directIndirectFromTitle(d.title);
      if (dealSource) update.direct_indirect = dealSource;
      let ipocTitle: string | null = null;
      if (d.contact) {
        ipocTitle = await acJobTitle(String(d.contact), d.account ? String(d.account) : null);
        if (ipocTitle) update.ipoc_job_title = ipocTitle;
        const ind = await acIndustry(String(d.contact), industryFieldId);
        if (ind) update.industry = ind;
      }
      s.ac_enriched++;

      // -- OpenAI enrichment --
      const en = await openaiEnrich(rec.company, rec.ipoc_name, ipocTitle);
      await sleep(300);
      if (en === "retry") {
        update.enrichment_attempts = (existing.get(rec.deal_id)?.enrichment_attempts ?? 0) + 1;
      } else {
        const ipocSen = bucketSeniority(en.ipoc_seniority) ?? seniorityFromTitle(ipocTitle);
        if (en.business_size) update.business_size = en.business_size;
        if (ipocSen) update.ipoc_seniority = ipocSen;
        // KDM: use the verified decision maker, else default to the primary contact.
        update.kdm_name = en.kdm_name ?? rec.ipoc_name;
        update.kdm_job_title = en.kdm_job_title ?? ipocTitle;
        update.kdm_seniority = bucketSeniority(en.kdm_seniority) ?? ipocSen;
        update.kdm_email = en.kdm_name && en.kdm_name !== rec.ipoc_name ? null : rec.ipoc_email;
        if (en.business_size || en.kdm_name || ipocSen) {
          update.enriched_at = now();
          update.enrichment_source = en.source ?? OPENAI_MODEL;
          s.openai_enriched++;
        } else {
          update.enrichment_attempts = (existing.get(rec.deal_id)?.enrichment_attempts ?? 0) + 1;
          s.openai_miss++;
        }
      }
      const { error } = await db.from("mag_buyer_sheet").update(update).eq("deal_id", rec.deal_id);
      if (error) s.errors.push(`${rec.deal_id} update: ${error.message}`);
    } catch (err) {
      s.errors.push(`${rec.deal_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("buyer-sheet-sync summary:", JSON.stringify(s));
  return s;
}

Deno.serve(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const limitParam = params.get("limit");
  let limit = limitParam ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  const sync = params.get("sync") === "1" || params.get("sync") === "true";

  if (sync) {
    const summary = await run(limit);
    return json({ mode: "sync", ...summary });
  }
  const work = run(limit).catch((e) => console.error("run failed:", e instanceof Error ? e.message : String(e)));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  return json({ mode: "async", status: "accepted", limit }, 202);
});
