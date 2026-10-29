// xero-ad-spend-sync
// ---------------------------------------------------------------------------
// Fills the ROAS "All-in" cost basis from Xero instead of the (blocked) Bing
// Ads API and the Simple Digital Gmail routine.
//
// MAG pays both Microsoft/Bing Ads and Simple Digital by card / direct debit;
// those charges land in Xero as reconciled SPEND bank transactions coded to the
// "Advertising and marketing" account (code 302), each tagged to the vendor's
// contact. They are NOT accounts-payable bills, so get_bills / the Invoices API
// never see them — but the Bank Transactions API does. This function reads them
// (READ-ONLY against Xero), buckets EX-GST spend by calendar month, and writes:
//   • Microsoft Ads  → public.bing_ads_campaign_monthly  (campaign_id = 0
//                      sentinel, campaign_name '__xero_msads__', cost = ex-GST).
//                      Replaces the temporary '__sheet_total__' load.
//   • Simple Digital → public.simple_digital_fees_monthly (one row per month;
//                      paid_search_fee = ex-GST). Replaces the sheet load and
//                      supersedes the simple-digital-fees-sync Gmail routine.
//   • Google Ads     → public.google_ads_xero_monthly (one row per month;
//                      cost = ex-GST). The ROAS page's Google cost for ALL
//                      financial years now comes from here (replacing Niki's
//                      per-lead cpc for FY22-24 and the Google Ads API /
//                      google_ads_campaign_monthly for FY25+). Unlike MS Ads /
//                      SD, the "Google" contact also has NON-ad charges on other
//                      accounts, so Google is summed from the EX-GST of the
//                      account-302 LINE ITEMS only (not the whole-txn SubTotal),
//                      across both the "Google" and "Google Ads" contacts.
// roas.js already SUMs cost / paid_search_fee over these tables, so no dashboard
// redeploy is needed — only the data changes.
//
// AUTH — FREE standard Xero app (authorization-code + refresh-token rotation),
// NOT a paid Custom Connection. xero-oauth-callback seeds the first refresh token
// into public.oauth_token_store (provider='xero'); each run here reads the latest
// token, mints an access token, and writes the rotated refresh token straight
// back (Xero refresh tokens rotate on every use and lapse after 60 days idle —
// the weekly cron keeps them alive). Tenant id is resolved live from /connections.
//
// READ-ONLY against Xero: only GET /connections and /BankTransactions.
//
// Secrets: XERO_CLIENT_ID, XERO_CLIENT_SECRET, SUPABASE_URL,
//          SUPABASE_SERVICE_ROLE_KEY, optional XERO_REFRESH_TOKEN (seed),
//          optional XERO_TENANT_ID (preferred org if several are connected).
//
// Invoke:
//   ?dry=1   → compute + return the monthly breakdown, write NOTHING (safe).
//   ?sync=1  → run inline, write, return a summary.
//   (bare)   → 202, run in background.
// Deploy with verify_jwt:false.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const XERO_CLIENT_ID = Deno.env.get("XERO_CLIENT_ID") ?? "";
const XERO_CLIENT_SECRET = Deno.env.get("XERO_CLIENT_SECRET") ?? "";
const XERO_REFRESH_SEED = Deno.env.get("XERO_REFRESH_TOKEN") ?? "";
// Preferred org id if several are connected (defaults to MyAdventure Group).
const PREFERRED_TENANT = Deno.env.get("XERO_TENANT_ID") ?? "2cc630e1-5f48-4cc7-b6ba-1d3cc0baf035";
// Pull spend from this date on. Starts at FY22 (2021-07) so the ROAS All-in cost basis
// also covers FY22–FY24 (Simple Digital history; Bing/MS Ads only began mid-FY25). Keep
// this a full-history floor: both writes below wipe-then-reinsert the whole window, so a
// narrower value on a later cron run would DELETE the FY22–24 rows.
const SINCE = Deno.env.get("XERO_SPEND_SINCE") ?? "2021-07-01";
// Simple Digital bundles a fixed SEO component into the direct debit from this month
// on; ROAS only counts the paid-search portion, so strip it (per CLAUDE.md).
const SD_SEO_FROM = Deno.env.get("XERO_SD_SEO_FROM") ?? "2026-03-01";
const SD_SEO_MONTHLY = Number(Deno.env.get("XERO_SD_SEO_MONTHLY") ?? "600");

// Xero contacts (from get_contacts on the MyAdventure Group org).
const MS_ADS_CONTACT_ID = Deno.env.get("XERO_MSADS_CONTACT_ID") ?? "5ea7b8c8-f858-413d-94c7-a70319948f64"; // "Microsoft Ads"
const SD_CONTACT_ID = Deno.env.get("XERO_SD_CONTACT_ID") ?? "fc88729b-8b63-4590-8d18-4c61eb2bea94"; // "Simple Digital"
// Google Ads is billed under TWO contacts over time ("Google" throughout, and
// "Google Ads" for a May-2023→Feb-2024 window) — both summed, 302-only. Override
// with a comma-separated XERO_GOOGLE_CONTACT_IDS.
const GOOGLE_CONTACT_IDS = (Deno.env.get("XERO_GOOGLE_CONTACT_IDS") ??
  "20732f2e-e12b-4f5d-9dfb-1bde837145aa,81b826a5-4fa1-498e-9078-c7de5f8c499b") // "Google", "Google Ads"
  .split(",").map((s) => s.trim()).filter(Boolean);
// The "Google" contact mixes ad spend (acct 302) with non-ad Google charges on
// other accounts — only account 302 line items are Google Ads spend.
const AD_ACCOUNT = Deno.env.get("XERO_AD_ACCOUNT") ?? "302"; // Advertising and marketing

const TOKEN_PROVIDER = "xero";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API = "https://api.xero.com/api.xro/2.0";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

const round2 = (n: number) => Math.round(n * 100) / 100;
const numOf = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Xero date → "YYYY-MM-DD". Handles ISO strings and "/Date(ms+0000)/".
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
interface XeroBankTxn {
  BankTransactionID: string;
  Type?: string | null;
  Status?: string | null;
  Contact?: { ContactID?: string | null; Name?: string | null } | null;
  Date?: string | null;
  DateString?: string | null;
  Reference?: string | null;
  LineAmountTypes?: string | null; // "Exclusive" | "Inclusive" | "NoTax"
  SubTotal?: unknown; // ex-GST
  TotalTax?: unknown;
  Total?: unknown; // inc-GST
  LineItems?: XeroLine[] | null;
}

// Mint an access token from the rotating refresh token, writing the new one back.
async function xeroAccessToken(db: SupabaseClient): Promise<string> {
  if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET) throw new Error("XERO_CLIENT_ID / XERO_CLIENT_SECRET not set.");
  const { data: tokRow } = await db
    .from("oauth_token_store").select("refresh_token").eq("provider", TOKEN_PROVIDER).maybeSingle();
  const refreshToken = (tokRow?.refresh_token as string) || XERO_REFRESH_SEED;
  if (!refreshToken) throw new Error("No Xero refresh token: authorise via xero-oauth-callback (or set XERO_REFRESH_TOKEN).");

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
  const { error: upErr } = await db
    .from("oauth_token_store")
    .upsert({ provider: TOKEN_PROVIDER, refresh_token: newRefresh, updated_at: new Date().toISOString() }, { onConflict: "provider" });
  if (upErr) console.error("[xero] failed to persist rotated refresh token:", upErr.message);
  return d.access_token as string;
}

// Resolve the tenant id to send in the xero-tenant-id header.
async function resolveTenant(access: string): Promise<string> {
  const r = await fetch(XERO_CONNECTIONS_URL, { headers: { Authorization: `Bearer ${access}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Xero connections ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const arr = await r.json();
  const orgs = (Array.isArray(arr) ? arr : []).filter((c) => c.tenantType === "ORGANISATION");
  if (!orgs.length) throw new Error("No Xero organisation is authorised for this app.");
  const match = orgs.find((c) => c.tenantId === PREFERRED_TENANT) || orgs[0];
  return match.tenantId as string;
}

// All SPEND bank transactions for one contact since SINCE. Read-only, paginated.
async function bankTxnsForContact(access: string, tenantId: string, contactId: string): Promise<XeroBankTxn[]> {
  const since = SINCE.split("-").map((x) => parseInt(x, 10));
  const where = encodeURIComponent(
    `Type=="SPEND" AND Status=="AUTHORISED" AND Contact.ContactID==guid("${contactId}") ` +
      `AND Date>=DateTime(${since[0]},${since[1]},${since[2]})`,
  );
  const out: XeroBankTxn[] = [];
  for (let page = 1; page <= 100; page++) {
    const url = `${XERO_API}/BankTransactions?where=${where}&page=${page}&order=Date`;
    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${access}`, "xero-tenant-id": tenantId, Accept: "application/json" },
    });
    if (r.status === 429) { await sleep(2000); page--; continue; }
    if (!r.ok) throw new Error(`Xero BankTransactions ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    const batch: XeroBankTxn[] = Array.isArray(d.BankTransactions) ? d.BankTransactions : [];
    out.push(...batch);
    if (batch.length < 100) break;
    await sleep(300);
  }
  return out;
}

interface MonthAgg { month: string; incGst: number; exGst: number; txns: number; lastDate: string | null }

function aggregateByMonth(txns: XeroBankTxn[]): { months: MonthAgg[]; accountCodes: string[] } {
  const map = new Map<string, MonthAgg>();
  const codes = new Set<string>();
  for (const t of txns) {
    const d = dateOnly(t.DateString ?? t.Date);
    const m = monthOf(d);
    if (!m) continue;
    for (const li of t.LineItems ?? []) if (li.AccountCode) codes.add(String(li.AccountCode));
    const cur = map.get(m) ?? { month: m, incGst: 0, exGst: 0, txns: 0, lastDate: null };
    cur.incGst += numOf(t.Total);
    cur.exGst += numOf(t.SubTotal);
    cur.txns += 1;
    if (!cur.lastDate || (d && d > cur.lastDate)) cur.lastDate = d;
    map.set(m, cur);
  }
  const months = [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
  for (const mo of months) { mo.incGst = round2(mo.incGst); mo.exGst = round2(mo.exGst); }
  return { months, accountCodes: [...codes].sort() };
}

// Google-specific: the "Google" contact mixes ad spend with non-ad Google
// charges, so bucket the EX-GST of the account-302 LINE ITEMS only, across all
// supplied txns (both Google contacts). Ex-GST per line = LineAmount, minus
// TaxAmount when the txn is tax-Inclusive (these bank charges are Inclusive, so
// LineAmount carries GST). Whole-txn SubTotal can't be used because it spans the
// non-302 lines too.
function aggregateGoogleAdMonths(txns: XeroBankTxn[]): MonthAgg[] {
  const map = new Map<string, MonthAgg>();
  for (const t of txns) {
    const d = dateOnly(t.DateString ?? t.Date);
    const m = monthOf(d);
    if (!m) continue;
    const inclusive = String(t.LineAmountTypes ?? "") === "Inclusive";
    let ad = 0;
    for (const li of t.LineItems ?? []) {
      if (String(li.AccountCode ?? "") !== AD_ACCOUNT) continue;
      ad += numOf(li.LineAmount) - (inclusive ? numOf(li.TaxAmount) : 0);
    }
    if (ad === 0) continue; // no Google Ads (acct 302) line on this txn
    const cur = map.get(m) ?? { month: m, incGst: 0, exGst: 0, txns: 0, lastDate: null };
    cur.exGst += ad;
    cur.txns += 1;
    if (!cur.lastDate || (d && d > cur.lastDate)) cur.lastDate = d;
    map.set(m, cur);
  }
  const months = [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
  for (const mo of months) mo.exGst = round2(mo.exGst);
  return months;
}

type Summary = {
  fn: string; mode: string; since: string; tenant: string | null;
  bing: { months: MonthAgg[]; totalExGst: number; txns: number; accountCodes: string[]; rowsWritten: number };
  sd: { months: MonthAgg[]; totalExGst: number; txns: number; accountCodes: string[]; rowsWritten: number };
  google: { months: MonthAgg[]; totalExGst: number; txns: number; rowsWritten: number };
  errors: string[];
};

async function run(dry: boolean): Promise<Summary> {
  const now = new Date().toISOString();
  const s: Summary = {
    fn: "xero-ad-spend-sync", mode: dry ? "dry" : "write", since: SINCE, tenant: null,
    bing: { months: [], totalExGst: 0, txns: 0, accountCodes: [], rowsWritten: 0 },
    sd: { months: [], totalExGst: 0, txns: 0, accountCodes: [], rowsWritten: 0 },
    google: { months: [], totalExGst: 0, txns: 0, rowsWritten: 0 },
    errors: [],
  };

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let access: string, tenantId: string;
  try {
    access = await xeroAccessToken(db);
    tenantId = await resolveTenant(access);
    s.tenant = tenantId;
  } catch (err) {
    s.errors.push(err instanceof Error ? err.message : String(err));
    return s;
  }

  // --- Microsoft Ads (Bing) ---
  try {
    const txns = await bankTxnsForContact(access, tenantId, MS_ADS_CONTACT_ID);
    const { months, accountCodes } = aggregateByMonth(txns);
    s.bing.months = months;
    s.bing.accountCodes = accountCodes;
    s.bing.txns = txns.length;
    s.bing.totalExGst = round2(months.reduce((a, m) => a + m.exGst, 0));
  } catch (err) { s.errors.push(`msads fetch: ${err instanceof Error ? err.message : String(err)}`); }

  // --- Simple Digital ---
  try {
    const txns = await bankTxnsForContact(access, tenantId, SD_CONTACT_ID);
    const { months, accountCodes } = aggregateByMonth(txns);
    s.sd.months = months;
    s.sd.accountCodes = accountCodes;
    s.sd.txns = txns.length;
    s.sd.totalExGst = round2(months.reduce((a, m) => a + m.exGst, 0));
  } catch (err) { s.errors.push(`simpledigital fetch: ${err instanceof Error ? err.message : String(err)}`); }

  // --- Google Ads (both contacts, account 302 line items, ex-GST) ---
  try {
    const all: XeroBankTxn[] = [];
    for (const cid of GOOGLE_CONTACT_IDS) all.push(...await bankTxnsForContact(access, tenantId, cid));
    const months = aggregateGoogleAdMonths(all);
    s.google.months = months;
    s.google.txns = months.reduce((a, m) => a + m.txns, 0);
    s.google.totalExGst = round2(months.reduce((a, m) => a + m.exGst, 0));
  } catch (err) { s.errors.push(`google fetch: ${err instanceof Error ? err.message : String(err)}`); }

  if (dry || s.errors.length) return s;

  // Bing: replace the campaign_id=0 sentinel (the temp sheet load) with Xero totals.
  if (s.bing.months.length) {
    const del = await db.from("bing_ads_campaign_monthly").delete().eq("campaign_id", 0);
    if (del.error) s.errors.push(`bing delete: ${del.error.message}`);
    const rows = s.bing.months.map((m) => ({
      month: m.month, account_id: "xero", campaign_id: 0, campaign_name: "__xero_msads__",
      cost: m.exGst, currency: "AUD", updated_at: now,
    }));
    const ins = await db.from("bing_ads_campaign_monthly").insert(rows);
    if (ins.error) s.errors.push(`bing insert: ${ins.error.message}`);
    else s.bing.rowsWritten = rows.length;
  }

  // Simple Digital: Xero becomes the sole source → replace every existing row.
  if (s.sd.months.length) {
    const del = await db.from("simple_digital_fees_monthly").delete().gte("month", "1900-01-01");
    if (del.error) s.errors.push(`sd delete: ${del.error.message}`);
    const rows = s.sd.months.map((m) => {
      const seo = m.month >= SD_SEO_FROM ? SD_SEO_MONTHLY : 0;
      return {
        month: m.month, invoice: "xero", notice_date: m.lastDate,
        amount_inc_gst: m.incGst, amount_ex_gst: m.exGst,
        seo_component: seo, paid_search_fee: round2(Math.max(0, m.exGst - seo)), updated_at: now,
      };
    });
    const ins = await db.from("simple_digital_fees_monthly").insert(rows);
    if (ins.error) s.errors.push(`sd insert: ${ins.error.message}`);
    else s.sd.rowsWritten = rows.length;
  }

  // Google Ads: Xero is the sole source → wipe-then-reinsert the whole window
  // (full-history floor, same contract as SINCE and the SD write above).
  if (s.google.months.length) {
    const del = await db.from("google_ads_xero_monthly").delete().gte("month", "1900-01-01");
    if (del.error) s.errors.push(`google delete: ${del.error.message}`);
    const rows = s.google.months.map((m) => ({
      month: m.month, cost: m.exGst, currency: "AUD", txns: m.txns, updated_at: now,
    }));
    const ins = await db.from("google_ads_xero_monthly").insert(rows);
    if (ins.error) s.errors.push(`google insert: ${ins.error.message}`);
    else s.google.rowsWritten = rows.length;
  }

  console.log("xero-ad-spend-sync summary:", JSON.stringify({ ...s, bing: { ...s.bing, months: s.bing.months.length }, sd: { ...s.sd, months: s.sd.months.length }, google: { ...s.google, months: s.google.months.length } }));
  return s;
}

Deno.serve(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const dry = params.get("dry") === "1" || params.get("dry") === "true";
  const sync = params.get("sync") === "1" || params.get("sync") === "true";

  if (dry || sync) {
    const summary = await run(dry);
    return json(summary, summary.errors.length ? 500 : 200);
  }
  const work = run(false).catch((e) => console.error("run failed:", e instanceof Error ? e.message : String(e)));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  return json({ mode: "async", status: "accepted" }, 202);
});
