// xero-channel-summary-sync
// ---------------------------------------------------------------------------
// Fills the Marketing ROI tab's "Channel Summary" chart from Xero (replacing the
// static load from the FY25-26 "MAG: MKTG ROI Report" workbook). READ-ONLY vs Xero.
//
// WHAT IT PULLS: every reconciled SPEND bank transaction (card/direct-debit) AND
// every accounts-payable bill (ACCPAY invoice) since SINCE, then keeps only the
// LINE ITEMS coded to the marketing accounts:
//   302 Advertising and marketing  | 475 Website expenses           (OPEN accounts)
//   332 Software subscriptions      | 411 Printing, stationery…      (SHARED accounts)
//   377 WrkPod Staff                                                 (SHARED account)
// Bank txns are invisible to the Invoices API / the claude.ai Xero MCP (they're not
// bills), so only the REST BankTransactions endpoint sees the ad spend — same reason
// xero-ad-spend-sync exists.
//
// CATEGORISATION is by VENDOR, not account: each stored row keeps (month, contact,
// account, ex-GST amount); the ROI API joins public.marketing_channel_vendor_map by
// contact_id to get Type/Platform. So re-categorising a vendor is a map edit, no
// Xero re-pull. A line is STORED when the contact is in the map (include=true) OR the
// line is on an OPEN account (302/475) — there an unmapped contact is a genuinely new
// marketing vendor, surfaced as "Uncategorized" on the chart. Unmapped contacts on the
// SHARED accounts (332/411/377, which also hold non-marketing spend) are dropped.
//
// ex-GST per line = LineAmount − (TaxAmount when the doc is tax-Inclusive). Bank card
// charges are Inclusive; bills are usually Exclusive (TaxAmount then already excluded).
//
// AUTH: reuses the free Xero web-app OAuth in public.oauth_token_store (provider='xero'),
// seeded by xero-oauth-callback and rotated here each run — identical to xero-ad-spend-sync.
//
// Writes public.marketing_channel_monthly by WIPE-THEN-REINSERT of the whole window.
// Secrets: XERO_CLIENT_ID, XERO_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//          optional XERO_REFRESH_TOKEN (seed), XERO_TENANT_ID, XERO_CHANNEL_SINCE.
//
// Invoke:  ?discover=1 → distinct (contact, account) totals + mapped? (build the map)
//          ?dry=1      → categorised monthly result, write NOTHING
//          ?sync=1     → run inline, write, return a summary
//          (bare)      → 202, run in background
// Deploy with verify_jwt:false.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const XERO_CLIENT_ID = Deno.env.get("XERO_CLIENT_ID") ?? "";
const XERO_CLIENT_SECRET = Deno.env.get("XERO_CLIENT_SECRET") ?? "";
const XERO_REFRESH_SEED = Deno.env.get("XERO_REFRESH_TOKEN") ?? "";
const PREFERRED_TENANT = Deno.env.get("XERO_TENANT_ID") ?? "2cc630e1-5f48-4cc7-b6ba-1d3cc0baf035";
// FY25-26 (the workbook's window) starts Jul 2025. Wipe-then-reinsert covers the whole
// window each run, so keep this a stable floor (narrowing it on a later run deletes history).
const SINCE = Deno.env.get("XERO_CHANNEL_SINCE") ?? "2025-07-01";

// Marketing account codes. OPEN = purely-marketing, unmapped vendors flagged as
// "Uncategorized". SHARED = also hold non-marketing, so only mapped vendors are kept.
const OPEN_ACCOUNTS = new Set((Deno.env.get("XERO_CHANNEL_OPEN_ACCOUNTS") ?? "302,475").split(",").map((s) => s.trim()));
const SHARED_ACCOUNTS = new Set((Deno.env.get("XERO_CHANNEL_SHARED_ACCOUNTS") ?? "332,411,377").split(",").map((s) => s.trim()));
const MKT_ACCOUNTS = new Set([...OPEN_ACCOUNTS, ...SHARED_ACCOUNTS]);

const TOKEN_PROVIDER = "xero";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API = "https://api.xero.com/api.xro/2.0";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
const round2 = (n: number) => Math.round(n * 100) / 100;
const numOf = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function dateOnly(v: unknown): string | null {
  const s = v == null ? "" : String(v).trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const ms = s.match(/\/Date\((\d+)/);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
const monthOf = (d: string | null): string | null => (d ? d.slice(0, 7) + "-01" : null);

interface XeroLine { AccountCode?: string | null; Description?: string | null; LineAmount?: unknown; TaxAmount?: unknown }
interface XeroDoc {
  Type?: string | null; Status?: string | null;
  Contact?: { ContactID?: string | null; Name?: string | null } | null;
  Date?: string | null; DateString?: string | null; DueDate?: string | null;
  LineAmountTypes?: string | null; LineItems?: XeroLine[] | null;
}

async function xeroAccessToken(db: SupabaseClient): Promise<string> {
  if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET) throw new Error("XERO_CLIENT_ID / XERO_CLIENT_SECRET not set.");
  const { data: tokRow } = await db.from("oauth_token_store").select("refresh_token").eq("provider", TOKEN_PROVIDER).maybeSingle();
  const refreshToken = (tokRow?.refresh_token as string) || XERO_REFRESH_SEED;
  if (!refreshToken) throw new Error("No Xero refresh token: authorise via xero-oauth-callback.");
  const basic = btoa(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`);
  const r = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!r.ok) throw new Error(`Xero refresh ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  if (!d.access_token) throw new Error("Xero token response had no access_token");
  const newRefresh = (d.refresh_token as string) || refreshToken;
  const { error: upErr } = await db.from("oauth_token_store")
    .upsert({ provider: TOKEN_PROVIDER, refresh_token: newRefresh, updated_at: new Date().toISOString() }, { onConflict: "provider" });
  if (upErr) console.error("[xero] failed to persist rotated refresh token:", upErr.message);
  return d.access_token as string;
}

async function resolveTenant(access: string): Promise<string> {
  const r = await fetch(XERO_CONNECTIONS_URL, { headers: { Authorization: `Bearer ${access}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Xero connections ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const arr = await r.json();
  const orgs = (Array.isArray(arr) ? arr : []).filter((c) => c.tenantType === "ORGANISATION");
  if (!orgs.length) throw new Error("No Xero organisation is authorised for this app.");
  const match = orgs.find((c) => c.tenantId === PREFERRED_TENANT) || orgs[0];
  return match.tenantId as string;
}

// Generic paginated GET of a document collection filtered by a `where` clause.
async function fetchDocs(access: string, tenantId: string, resource: "BankTransactions" | "Invoices", where: string, key: string): Promise<XeroDoc[]> {
  const out: XeroDoc[] = [];
  for (let page = 1; page <= 200; page++) {
    const url = `${XERO_API}/${resource}?where=${encodeURIComponent(where)}&page=${page}&order=Date`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${access}`, "xero-tenant-id": tenantId, Accept: "application/json" } });
    if (r.status === 429) { await sleep(2000); page--; continue; }
    if (!r.ok) throw new Error(`Xero ${resource} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    const batch: XeroDoc[] = Array.isArray(d[key]) ? d[key] : [];
    out.push(...batch);
    if (batch.length < 100) break;
    await sleep(300);
  }
  return out;
}

const sinceParts = () => SINCE.split("-").map((x) => parseInt(x, 10));

async function fetchBankTxns(access: string, tenantId: string): Promise<XeroDoc[]> {
  const [y, m, d] = sinceParts();
  return fetchDocs(access, tenantId, "BankTransactions",
    `Type=="SPEND" AND Status=="AUTHORISED" AND Date>=DateTime(${y},${m},${d})`, "BankTransactions");
}
async function fetchBills(access: string, tenantId: string): Promise<XeroDoc[]> {
  const [y, m, d] = sinceParts();
  return fetchDocs(access, tenantId, "Invoices",
    `Type=="ACCPAY" AND Status!="DELETED" AND Status!="VOIDED" AND Date>=DateTime(${y},${m},${d})`, "Invoices");
}

interface Bucket { month: string; contactId: string; vendor: string; account: string; amount: number }

// Flatten docs → one bucket per (month, contact, account) over marketing-account lines only.
function bucketLines(docs: XeroDoc[]): Map<string, Bucket> {
  const map = new Map<string, Bucket>();
  for (const doc of docs) {
    const dt = dateOnly(doc.DateString ?? doc.Date);
    const month = monthOf(dt);
    if (!month) continue;
    const contactId = doc.Contact?.ContactID ? String(doc.Contact.ContactID) : "";
    const vendor = doc.Contact?.Name ? String(doc.Contact.Name) : "(no contact)";
    const inclusive = String(doc.LineAmountTypes ?? "") === "Inclusive";
    for (const li of doc.LineItems ?? []) {
      const acct = String(li.AccountCode ?? "");
      if (!MKT_ACCOUNTS.has(acct)) continue;
      const exGst = numOf(li.LineAmount) - (inclusive ? numOf(li.TaxAmount) : 0);
      if (!exGst) continue;
      const k = `${month}|${contactId}|${acct}`;
      const cur = map.get(k) ?? { month, contactId, vendor, account: acct, amount: 0 };
      cur.amount += exGst;
      map.set(k, cur);
    }
  }
  for (const b of map.values()) b.amount = round2(b.amount);
  return map;
}

type MapRow = { contact_id: string; type: string; platform: string | null; include: boolean };

async function run(mode: "discover" | "dry" | "sync") {
  const now = new Date().toISOString();
  const s: Record<string, unknown> = { fn: "xero-channel-summary-sync", mode, since: SINCE, tenant: null, errors: [] as string[], warnings: [] as string[] };
  const errors = s.errors as string[];
  const warnings = s.warnings as string[];
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let access: string, tenantId: string;
  try { access = await xeroAccessToken(db); tenantId = await resolveTenant(access); s.tenant = tenantId; }
  catch (err) { errors.push(err instanceof Error ? err.message : String(err)); return s; }

  let buckets: Map<string, Bucket>;
  try {
    const bank = await fetchBankTxns(access, tenantId);
    // Bills (ACCPAY) are best-effort: the app's Xero scope may not include invoices
    // (only accounting.banktransactions.read). A 401/403 there is a WARNING, not fatal —
    // we still sync from bank transactions.
    let bills: XeroDoc[] = [];
    try { bills = await fetchBills(access, tenantId); }
    catch (err) { warnings.push(`bills skipped: ${err instanceof Error ? err.message : String(err)}`); }
    s.docs = { bankTxns: bank.length, bills: bills.length };
    buckets = bucketLines([...bank, ...bills]);
  } catch (err) { errors.push(err instanceof Error ? err.message : String(err)); return s; }

  // Load the vendor map.
  const { data: mapRows, error: mapErr } = await db.from("marketing_channel_vendor_map").select("contact_id,type,platform,include");
  if (mapErr) errors.push(`map load: ${mapErr.message}`);
  const vmap = new Map<string, MapRow>((mapRows ?? []).map((r) => [String(r.contact_id), r as MapRow]));

  // DISCOVER: distinct (contact, account) totals + whether mapped — to build the map.
  if (mode === "discover") {
    const byContact = new Map<string, { contactId: string; vendor: string; accounts: Record<string, number>; total: number; mapped: boolean }>();
    for (const b of buckets.values()) {
      const e = byContact.get(b.contactId) ?? { contactId: b.contactId, vendor: b.vendor, accounts: {}, total: 0, mapped: vmap.has(b.contactId) };
      e.accounts[b.account] = round2((e.accounts[b.account] ?? 0) + b.amount);
      e.total = round2(e.total + b.amount);
      byContact.set(b.contactId, e);
    }
    s.contacts = [...byContact.values()].sort((a, b) => b.total - a.total);
    s.contactCount = byContact.size;
    return s;
  }

  // Decide which buckets to KEEP: mapped(include) OR line on an OPEN account.
  const keep: Bucket[] = [];
  const uncategorized: Record<string, number> = {};
  for (const b of buckets.values()) {
    const mr = vmap.get(b.contactId);
    const isOpen = OPEN_ACCOUNTS.has(b.account);
    if (mr) { if (mr.include) keep.push(b); continue; }
    if (isOpen) { keep.push(b); uncategorized[b.vendor] = round2((uncategorized[b.vendor] ?? 0) + b.amount); }
  }
  s.kept = keep.length;
  s.uncategorizedVendors = uncategorized;
  s.total = round2(keep.reduce((a, b) => a + b.amount, 0));

  if (mode === "dry") { s.sample = keep.slice(0, 25); return s; }

  // SYNC: wipe-then-reinsert the whole window.
  const del = await db.from("marketing_channel_monthly").delete().gte("month", "1900-01-01");
  if (del.error) errors.push(`delete: ${del.error.message}`);
  const rows = keep.map((b) => ({ month: b.month, contact_id: b.contactId, vendor: b.vendor, account_code: b.account, amount: b.amount, updated_at: now }));
  for (let i = 0; i < rows.length; i += 500) {
    const ins = await db.from("marketing_channel_monthly").insert(rows.slice(i, i + 500));
    if (ins.error) errors.push(`insert[${i}]: ${ins.error.message}`);
  }
  s.rowsWritten = rows.length;
  console.log("xero-channel-summary-sync:", JSON.stringify({ ...s, sample: undefined }));
  return s;
}

Deno.serve(async (req: Request) => {
  const p = new URL(req.url).searchParams;
  const discover = p.get("discover") === "1" || p.get("discover") === "true";
  const dry = p.get("dry") === "1" || p.get("dry") === "true";
  const sync = p.get("sync") === "1" || p.get("sync") === "true";
  if (discover || dry || sync) {
    const summary = await run(discover ? "discover" : dry ? "dry" : "sync");
    return json(summary, (summary.errors as string[]).length ? 500 : 200);
  }
  const work = run("sync").catch((e) => console.error("run failed:", e instanceof Error ? e.message : String(e)));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  return json({ mode: "async", status: "accepted" }, 202);
});
