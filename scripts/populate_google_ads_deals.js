const SUPABASE_URL = process.env.SUPABASE_URL || 'https://aivitcomiywiysrfwqxt.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AC_API_URL = (process.env.AC_API_URL || 'https://myadventuregroup.api-us1.com').replace(/\/+$/, '');
const AC_API_TOKEN = process.env.AC_API_TOKEN;

const acHeaders = {
  'Api-Token': AC_API_TOKEN,
  'Content-Type': 'application/json',
};

const sbHeaders = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=merge-duplicates',
};

async function acGet(path) {
  try {
    const r = await fetch(`${AC_API_URL}/api/3/${path}`, { headers: acHeaders });
    if (!r.ok) {
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, 1500));
        return acGet(path);
      }
      return null;
    }
    return await r.json();
  } catch (err) {
    console.error(`AC error for ${path}:`, err.message);
    return null;
  }
}

async function sbGet(table, query = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: sbHeaders });
  if (!r.ok) {
    console.error(`Supabase error fetching ${table}:`, await r.text());
    return [];
  }
  return await r.json();
}

async function sbUpsert(table, rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders,
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    console.error(`Supabase error upserting into ${table}:`, await r.text());
    return false;
  }
  return true;
}

async function main() {
  console.log('Fetching all AC dealCustomFieldData for "Google Ads? = Yes"...');
  const googleAdsDeals = new Map(); // dealId -> { googleAds: 'Yes', dealSource: null }
  let offset = 0;
  const limit = 100;

  while (true) {
    const d = await acGet(`dealCustomFieldData?limit=${limit}&offset=${offset}`);
    const items = d?.dealCustomFieldData || [];
    if (!items.length) break;

    for (const it of items) {
      const fieldId = String(it.customFieldId ?? it.dealCustomFieldMetumId ?? '');
      const dId = String(it.dealId ?? '');
      if (!dId) continue;

      if (fieldId === '18') {
        const val = String(it.fieldValue || '').trim();
        if (val.toLowerCase() === 'yes') {
          if (!googleAdsDeals.has(dId)) {
            googleAdsDeals.set(dId, { dealId: dId, googleAds: 'Yes', dealSource: null });
          }
        }
      } else if (fieldId === '6') {
        const val = String(it.fieldValue || '').trim();
        if (googleAdsDeals.has(dId)) {
          googleAdsDeals.get(dId).dealSource = val;
        }
      }
    }

    offset += limit;
    if (offset % 5000 === 0) console.log(`Scanned ${offset} custom field records...`);
  }

  const dealIds = Array.from(googleAdsDeals.keys());
  console.log(`Found ${dealIds.length} deals with "Google Ads? = Yes".`);

  // Target query: only fetch the deals we need from Supabase
  console.log('Fetching deal records for the matched 98 deals...');
  const dealsData = await sbGet('activecampaign_deals', `id=in.(${dealIds.join(',')})&select=*`);
  const dealMap = new Map((dealsData || []).map((d) => [String(d.id), d]));

  // Collect contact IDs and account IDs
  const contactIds = new Set();
  const accountIds = new Set();

  for (const dealId of dealIds) {
    let deal = dealMap.get(dealId);
    if (!deal) {
      const acDealRes = await acGet(`deals/${dealId}`);
      deal = acDealRes?.deal;
      if (deal) dealMap.set(dealId, deal);
    }
    if (deal?.contact) contactIds.add(String(deal.contact));
    if (deal?.account || deal?.organization) accountIds.add(String(deal.account || deal.organization));
  }

  // Fetch only needed contacts & accounts
  console.log(`Fetching ${contactIds.size} contacts and ${accountIds.size} accounts...`);
  const contactArr = Array.from(contactIds);
  const accountArr = Array.from(accountIds);

  let contactsData = [];
  if (contactArr.length) {
    contactsData = await sbGet('activecampaign_contacts', `id=in.(${contactArr.join(',')})&select=*`);
  }
  const contactMap = new Map((contactsData || []).map((c) => [String(c.id), c]));

  let accountsData = [];
  if (accountArr.length) {
    accountsData = await sbGet('activecampaign_accounts', `id=in.(${accountArr.join(',')})&select=*`);
  }
  const accountMap = new Map((accountsData || []).map((a) => [String(a.id), a]));

  const sourceTypesData = await sbGet('ac_deal_source_type', `deal_id=in.(${dealIds.join(',')})&select=*`);
  const sourceTypeMap = new Map((sourceTypesData || []).map((st) => [String(st.deal_id), st.source_type]));

  const rowsToUpsert = [];

  for (const [dealId, cf] of googleAdsDeals.entries()) {
    let deal = dealMap.get(dealId);

    const contactId = deal ? String(deal.contact || '') : null;
    let contact = contactId ? contactMap.get(contactId) : null;
    if (contactId && !contact) {
      const acContactRes = await acGet(`contacts/${contactId}`);
      contact = acContactRes?.contact;
      if (contact) contactMap.set(contactId, contact);
    }

    const accountId = deal ? String(deal.account || deal.organization || '') : null;
    let account = accountId ? accountMap.get(accountId) : null;
    if (accountId && !account) {
      const acAccountRes = await acGet(`accounts/${accountId}`);
      account = acAccountRes?.account;
      if (account) accountMap.set(accountId, account);
    }

    const rawVal = deal?.value != null ? Number(deal.value) : null;
    const valDollars = rawVal != null ? rawVal / 100.0 : null;

    let statusText = 'open';
    const sRaw = deal?.status != null ? Number(deal.status) : 0;
    if (sRaw === 1) statusText = 'won';
    else if (sRaw === 2) statusText = 'lost';

    const contactName = contact
      ? [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || null
      : null;

    rowsToUpsert.push({
      deal_id: dealId,
      title: deal?.title || null,
      value: valDollars,
      value_cents: rawVal,
      currency: deal?.currency ? String(deal.currency).toLowerCase() : 'aud',
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

  console.log(`Upserting ${rowsToUpsert.length} records into public.ac_google_ads_deals...`);

  // Batch upsert in chunks of 50
  for (let i = 0; i < rowsToUpsert.length; i += 50) {
    const chunk = rowsToUpsert.slice(i, i + 50);
    const ok = await sbUpsert('ac_google_ads_deals', chunk);
    if (!ok) {
      console.error('Failed to upsert chunk', i);
    }
  }

  console.log('Successfully stored all Google Ads deals in Supabase!');
}

main().catch(console.error);
