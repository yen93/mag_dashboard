// ga4-ac-custom-fields-sync — populates google_ads_ac_field and deal_source_ac_field
// on public.ga4_ac_contact_source from ActiveCampaign deal custom fields.
//
// Custom fields resolved dynamically from ActiveCampaign dealCustomFieldMeta:
//   * google_ads_ac_field  -> "Google Ads?" (under Qualification Details)
//   * deal_source_ac_field -> "Deal Source?" (under Qualification Details)
//
// Performance optimization:
//   Fetches custom field data per unique deal_id (deduplicating across contacts)
//   and bulk updates public.ga4_ac_contact_source matching each deal_id.
//
// Invoke:
//   GET/POST ?sync=1 runs inline and returns the detailed summary.
//   GET/POST (bare) runs in background via EdgeRuntime.waitUntil and returns 202.
//
// Secrets required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AC_API_URL, AC_API_TOKEN.
//
// Deploy command:
//   supabase functions deploy ga4-ac-custom-fields-sync --no-verify-jwt

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AC_API_URL = (Deno.env.get("AC_API_URL") ?? "").replace(/\/+$/, "");
const AC_API_TOKEN = Deno.env.get("AC_API_TOKEN") ?? "";

const WALL_CLOCK_MS = parseInt(Deno.env.get("WALL_CLOCK_MS") ?? "150000", 10);
const PER_DEAL_RESERVE_MS = parseInt(Deno.env.get("PER_DEAL_RESERVE_MS") ?? "3000", 10);

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

const cleanValue = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).replace(/\|+/g, ", ").replace(/^,\s*|,\s*$/g, "").trim();
  return s || null;
};

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

interface ResolvedFieldMeta {
  googleAdsId: string | null;
  dealSourceId: string | null;
}

// Dynamically resolve custom field IDs by label from AC metadata
async function resolveCustomFieldMeta(): Promise<ResolvedFieldMeta> {
  const metaRes = await acGet("dealCustomFieldMeta?limit=100");
  const list = metaRes && Array.isArray(metaRes.dealCustomFieldMeta) ? metaRes.dealCustomFieldMeta : [];

  let googleAdsId: string | null = null;
  let dealSourceId: string | null = null;

  for (const m of list) {
    const label = String(m.fieldLabel || "").trim().toLowerCase();
    const id = String(m.id);

    if (!googleAdsId && (label === "google ads?" || label === "google ads" || label.includes("google ads"))) {
      googleAdsId = id;
    }
    if (!dealSourceId && (label === "deal source?" || label === "deal source" || label.includes("deal source"))) {
      dealSourceId = id;
    }
  }

  return { googleAdsId, dealSourceId };
}

// Fetch custom field values for a specific deal
async function fetchDealCustomFields(
  dealId: string,
  fieldMeta: ResolvedFieldMeta
): Promise<{ googleAds: string | null; dealSource: string | null }> {
  const d = await acGet(`deals/${dealId}/dealCustomFieldData?limit=100`);
  const list = d && Array.isArray(d.dealCustomFieldData) ? d.dealCustomFieldData : [];

  const byField: Record<string, unknown> = {};
  for (const v of list) {
    const k = String(v.customFieldId ?? v.dealCustomFieldMetumId ?? v.custom_field_id ?? "");
    if (k) byField[k] = v.fieldValue;
  }

  const googleAds = fieldMeta.googleAdsId ? cleanValue(byField[fieldMeta.googleAdsId]) : null;
  const dealSource = fieldMeta.dealSourceId ? cleanValue(byField[fieldMeta.dealSourceId]) : null;

  return { googleAds, dealSource };
}

// ---- Main Sync Runner ------------------------------------------------------
type Summary = {
  fn: string;
  fields_resolved: ResolvedFieldMeta;
  total_contacts_with_deals: number;
  distinct_deals_count: number;
  deals_processed: number;
  contacts_updated: number;
  duration_ms: number;
  stopped_early: boolean;
  errors: string[];
};

async function run(): Promise<Summary> {
  const started = Date.now();
  const summary: Summary = {
    fn: "ga4-ac-custom-fields-sync",
    fields_resolved: { googleAdsId: null, dealSourceId: null },
    total_contacts_with_deals: 0,
    distinct_deals_count: 0,
    deals_processed: 0,
    contacts_updated: 0,
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

  // 1. Resolve custom field IDs from ActiveCampaign
  const fieldMeta = await resolveCustomFieldMeta();
  summary.fields_resolved = fieldMeta;

  if (!fieldMeta.googleAdsId && !fieldMeta.dealSourceId) {
    summary.errors.push("Could not resolve 'Google Ads?' or 'Deal Source?' field IDs from dealCustomFieldMeta.");
    return summary;
  }

  // 2. Query all contacts from ga4_ac_contact_source that have a deal_id
  const { data: contacts, error: fetchErr } = await db
    .from("ga4_ac_contact_source")
    .select("contact_id, deal_id, google_ads_ac_field, deal_source_ac_field")
    .not("deal_id", "is", null);

  if (fetchErr) {
    summary.errors.push(`Error fetching ga4_ac_contact_source: ${fetchErr.message}`);
    return summary;
  }

  const contactList = contacts || [];
  summary.total_contacts_with_deals = contactList.length;

  // Group contacts by deal_id to minimize ActiveCampaign API requests
  const dealToContacts = new Map<string, typeof contactList>();
  for (const c of contactList) {
    if (!c.deal_id) continue;
    const dId = String(c.deal_id).trim();
    if (!dId) continue;
    if (!dealToContacts.has(dId)) {
      dealToContacts.set(dId, []);
    }
    dealToContacts.get(dId)!.push(c);
  }

  const distinctDealIds = Array.from(dealToContacts.keys());
  summary.distinct_deals_count = distinctDealIds.length;

  // 3. Process each deal
  for (const dealId of distinctDealIds) {
    if (Date.now() - started > WALL_CLOCK_MS - PER_DEAL_RESERVE_MS) {
      summary.stopped_early = true;
      break;
    }

    try {
      const { googleAds, dealSource } = await fetchDealCustomFields(dealId, fieldMeta);

      // Update public.ga4_ac_contact_source for all contacts mapped to this deal
      const { error: updateErr, count } = await db
        .from("ga4_ac_contact_source")
        .update({
          google_ads_ac_field: googleAds,
          deal_source_ac_field: dealSource,
          updated_at: new Date().toISOString(),
        })
        .eq("deal_id", dealId);

      if (updateErr) {
        summary.errors.push(`Failed to update deal ${dealId}: ${updateErr.message}`);
      } else {
        summary.deals_processed++;
        const affected = dealToContacts.get(dealId)?.length || 0;
        summary.contacts_updated += affected;
      }

      await sleep(150); // Respect ActiveCampaign rate limit
    } catch (e: any) {
      summary.errors.push(`Error processing deal ${dealId}: ${e?.message || e}`);
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
    return json(res, res.errors.length && !res.deals_processed ? 500 : 200);
  }

  // Async mode: return 202 immediately and run in the background
  if (EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(
      run().then((summary) => console.log("[ga4-ac-custom-fields-sync] done:", JSON.stringify(summary)))
    );
    return json({ message: "Sync started in background", timestamp: new Date().toISOString() }, 202);
  }

  // Fallback if EdgeRuntime not present
  const res = await run();
  return json(res, 200);
});
