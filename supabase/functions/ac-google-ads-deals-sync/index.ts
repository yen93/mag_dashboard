// ac-google-ads-deals-sync — scans ActiveCampaign for all deals where the custom
// field "Google Ads?" is set to "Yes", joins deal/contact/account metadata, and
// UPSERTs them into public.ac_google_ads_deals.
//
// Scheduled to run daily at 05:30 AM Philippine Time (21:30 UTC).
//
// Invoke:
//   GET/POST ?sync=1 runs inline and returns the detailed summary.
//   GET/POST (bare) runs in background via EdgeRuntime.waitUntil and returns 202.
//
// Secrets required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AC_API_URL, AC_API_TOKEN.
//
// Deploy command:
//   supabase functions deploy ac-google-ads-deals-sync --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AC_API_URL = (Deno.env.get("AC_API_URL") ?? "").replace(/\/+$/, "");
const AC_API_TOKEN = Deno.env.get("AC_API_TOKEN") ?? "";

const WALL_CLOCK_MS = parseInt(Deno.env.get("WALL_CLOCK_MS") ?? "150000", 10);
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

// ---- ActiveCampaign REST v3 Helpers ----------------------------------------
const acHeaders = {
  "Api-Token": AC_API_TOKEN,
  "Content-Type": "application/json",
};

async function acGet(path: string): Promise<any | null> {
  try {
    const r = await fetch(`${AC_API_URL}/api/3/${path}`, { headers: acHeaders });
    if (!r.ok) {
      if (r.status === 429) {
        await sleep(1500);
        return acGet(path);
      }
      console.warn(`AC ${r.status} for ${path}`);
      return null;
    }
    return await r.json();
  } catch (err) {
    console.warn(`AC fetch failed for ${path}: ${err}`);
    return null;
  }
}

interface CustomFieldMeta {
  googleAdsId: string | null;
  dealSourceId: string | null;
}

async function resolveFieldMeta(): Promise<CustomFieldMeta> {
  const metaRes = await acGet("dealCustomFieldMeta?limit=100");
  const list = metaRes && Array.isArray(metaRes.dealCustomFieldMeta) ? metaRes.dealCustomFieldMeta : [];

  let googleAdsId: string | null = null;
  let dealSourceId: string | null = null;

  for (const m of list) {
    const label = String(m.fieldLabel || "").trim().toLowerCase();
    const id = String(m.id);
    if (!googleAdsId && (label === "google ads?" || label.includes("google ads"))) {
      googleAdsId = id;
    }
    if (!dealSourceId && (label === "deal source?" || label.includes("deal source"))) {
      dealSourceId = id;
    }
  }

  return { googleAdsId: googleAdsId || "18", dealSourceId: dealSourceId || "6" };
}

type Summary = {
  fn: string;
  scanned_cf_records: number;
  google_ads_deals_found: number;
  upserted_deals: number;
  duration_ms: number;
  stopped_early: boolean;
  errors: string[];
};

async function run(): Promise<Summary> {
  const started = Date.now();
  const summary: Summary = {
    fn: "ac-google-ads-deals-sync",
    scanned_cf_records: 0,
    google_ads_deals_found: 0,
    upserted_deals: 0,
    duration_ms: 0,
    stopped_early: false,
    errors: [],
  };

  if (!AC_API_URL || !AC_API_TOKEN) {
    summary.errors.push("Missing ActiveCampaign credentials (AC_API_URL / AC_API_TOKEN).");
    return summary;
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    summary.errors.push("Missing Supabase credentials (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
    return summary;
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // 1. Resolve custom field IDs
  const meta = await resolveFieldMeta();
  const gAdsFieldId = meta.googleAdsId;
  const dSourceFieldId = meta.dealSourceId;

  // 2. Scan all dealCustomFieldData for "Google Ads? = Yes"
  const matchedDeals = new Map<string, { googleAds: string; dealSource: string | null }>();
  let offset = 0;
  const pageSize = 100;

  while (true) {
    if (Date.now() - started > WALL_CLOCK_MS - 15000) {
      summary.stopped_early = true;
      break;
    }

    const d = await acGet(`dealCustomFieldData?limit=${pageSize}&offset=${offset}`);
    const items = d && Array.isArray(d.dealCustomFieldData) ? d.dealCustomFieldData : [];
    if (!items.length) break;

    summary.scanned_cf_records += items.length;

    for (const it of items) {
      const fieldId = String(it.customFieldId ?? it.dealCustomFieldMetumId ?? "");
      const dId = String(it.dealId ?? "");
      if (!dId) continue;

      if (fieldId === gAdsFieldId) {
        const val = String(it.fieldValue || "").trim();
        if (val.toLowerCase() === "yes") {
          if (!matchedDeals.has(dId)) {
            matchedDeals.set(dId, { googleAds: "Yes", dealSource: null });
          }
        }
      } else if (fieldId === dSourceFieldId) {
        const val = String(it.fieldValue || "").trim();
        if (matchedDeals.has(dId)) {
          matchedDeals.get(dId)!.dealSource = val;
        }
      }
    }

    offset += pageSize;
    if (items.length < pageSize) break;
  }

  const dealIds = Array.from(matchedDeals.keys());
  summary.google_ads_deals_found = dealIds.length;

  if (!dealIds.length) {
    summary.duration_ms = Date.now() - started;
    return summary;
  }

  // 3. Fetch deal records from Supabase mirror (or fallback to AC API)
  const { data: dealsData } = await db
    .from("activecampaign_deals")
    .select("*")
    .in("id", dealIds);

  const dealMap = new Map<string, any>((dealsData || []).map((d: any) => [String(d.id), d]));

  const contactIds = new Set<string>();
  const accountIds = new Set<string>();

  for (const dealId of dealIds) {
    let deal = dealMap.get(dealId);
    if (!deal) {
      const acDeal = await acGet(`deals/${dealId}`);
      if (acDeal?.deal) {
        deal = acDeal.deal;
        dealMap.set(dealId, deal);
      }
    }
    if (deal?.contact) contactIds.add(String(deal.contact));
    if (deal?.account || deal?.organization) accountIds.add(String(deal.account || deal.organization));
  }

  // 4. Fetch contact & account details
  const contactArr = Array.from(contactIds);
  const accountArr = Array.from(accountIds);

  const [contactsRes, accountsRes, sourceTypesRes] = await Promise.all([
    contactArr.length ? db.from("activecampaign_contacts").select("*").in("id", contactArr) : { data: [] },
    accountArr.length ? db.from("activecampaign_accounts").select("*").in("id", accountArr) : { data: [] },
    db.from("ac_deal_source_type").select("*").in("deal_id", dealIds),
  ]);

  const contactMap = new Map<string, any>((contactsRes.data || []).map((c: any) => [String(c.id), c]));
  const accountMap = new Map<string, any>((accountsRes.data || []).map((a: any) => [String(a.id), a]));
  const sourceTypeMap = new Map<string, string>((sourceTypesRes.data || []).map((st: any) => [String(st.deal_id), st.source_type]));

  // 5. Construct rows to upsert
  const rowsToUpsert: any[] = [];

  for (const [dealId, cf] of matchedDeals.entries()) {
    const deal = dealMap.get(dealId);
    const contactId = deal ? String(deal.contact || "") : null;
    const contact = contactId ? contactMap.get(contactId) : null;
    const accountId = deal ? String(deal.account || deal.organization || "") : null;
    const account = accountId ? accountMap.get(accountId) : null;

    const rawVal = deal?.value != null ? Number(deal.value) : null;
    const valDollars = rawVal != null ? rawVal / 100.0 : null;

    let statusText = "open";
    const sRaw = deal?.status != null ? Number(deal.status) : 0;
    if (sRaw === 1) statusText = "won";
    else if (sRaw === 2) statusText = "lost";

    const contactName = contact
      ? [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || null
      : null;

    rowsToUpsert.push({
      deal_id: dealId,
      title: deal?.title || null,
      value: valDollars,
      value_cents: rawVal,
      currency: deal?.currency ? String(deal.currency).toLowerCase() : "aud",
      status: statusText,
      status_raw: sRaw,
      stage: deal?.stage ? String(deal.stage) : null,
      stage_id: deal?.stage ? String(deal.stage) : null,
      deal_group: deal?.group ? String(deal.group) : null,
      contact_id: contactId || null,
      contact_email: contact?.email ? String(contact.email).toLowerCase() : null,
      contact_name: contactName,
      contact_phone: contact?.phone || null,
      account_id: accountId || null,
      account_name: account?.name || deal?.orgname || null,
      deal_cdate: deal?.cdate || null,
      deal_mdate: deal?.mdate || deal?.udate || null,
      google_ads_field: cf.googleAds,
      deal_source_field: cf.dealSource || null,
      source_type: sourceTypeMap.get(dealId) || null,
      owner_id: deal?.owner ? String(deal.owner) : null,
      updated_at: new Date().toISOString(),
    });
  }

  // 6. Batch UPSERT into public.ac_google_ads_deals
  for (let i = 0; i < rowsToUpsert.length; i += 50) {
    const chunk = rowsToUpsert.slice(i, i + 50);
    const { error: upsertErr } = await db
      .from("ac_google_ads_deals")
      .upsert(chunk, { onConflict: "deal_id" });

    if (upsertErr) {
      summary.errors.push(`Error upserting batch ${i}: ${upsertErr.message}`);
    } else {
      summary.upserted_deals += chunk.length;
    }
  }

  summary.duration_ms = Date.now() - started;
  return summary;
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
    return json(res, res.errors.length && !res.upserted_deals ? 500 : 200);
  }

  // Async mode: return 202 immediately and run in background
  if (EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(
      run().then((summary) => console.log("[ac-google-ads-deals-sync] done:", JSON.stringify(summary)))
    );
    return json({ message: "Sync started in background", timestamp: new Date().toISOString() }, 202);
  }

  const res = await run();
  return json(res, 200);
});
