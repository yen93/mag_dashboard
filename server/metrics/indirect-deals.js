// Marketing — Indirect Deals.
//
// Reads public.ac_indirect_deals (rebuilt/upserted by the ac-bureau-deals-sync edge function).
// Backs the "Indirect Deals" table on public/email_partners.html (/api/marketing/indirect-deals).

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC = 'Supabase public.ac_indirect_deals (ActiveCampaign indirect / bureau / tailor deals mirror)';

const SQL = `
  SELECT
    deal_id        AS "dealId",
    title,
    deal_source    AS "dealSource",
    pipeline_id    AS "pipelineId",
    pipeline_name  AS "pipelineName",
    stage_id       AS "stageId",
    status,
    status_label   AS "statusLabel",
    contact_id     AS "contactId",
    contact_name   AS "contactName",
    contact_email  AS "contactEmail",
    account_id     AS "accountId",
    organization,
    coalesce(nullif(organization, ''), contact_name) AS org,
    value_raw      AS "valueRaw",
    value_aud      AS "value",
    currency,
    cdate,
    to_char(cdate, 'YYYY-MM-DD') AS date,
    to_char(date_trunc('month', cdate), 'YYYY-MM') AS month,
    mdate,
    event_date     AS "eventDate",
    cal_yr         AS "calYr",
    fy,
    (extract(year from cdate)::int + case when extract(month from cdate) >= 7 then 1 else 0 end) AS "fyEnd",
    is_tailor      AS "isTailor",
    CASE WHEN is_tailor THEN 'The Tailor' ELSE 'Speaker bureaus' END AS partner,
    (status = 1)   AS won
  FROM public.ac_indirect_deals
  WHERE cdate IS NOT NULL
  ORDER BY cdate DESC`;

export async function getIndirectDeals() {
  if (!supabaseConfigured()) {
    return {
      deals: [],
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' },
    };
  }

  const rows = await q(SQL);
  const n = (v) => (v == null ? 0 : Number(v) || 0);

  const deals = rows.map((r) => ({
    dealId: r.dealId,
    title: r.title || '',
    dealSource: r.dealSource || '',
    pipelineName: r.pipelineName || '',
    statusCode: r.status,
    status: r.statusLabel || (r.status === 1 ? 'Won' : r.status === 2 ? 'Lost' : 'Open'),
    statusLabel: r.statusLabel || (r.status === 1 ? 'Won' : r.status === 2 ? 'Lost' : 'Open'),
    contactName: r.contactName || '',
    contactEmail: r.contactEmail || '',
    contact: r.contactName || r.contactEmail || '',
    organization: r.organization || '',
    org: r.org || '',
    value: n(r.value),
    currency: r.currency || 'AUD',
    cdate: r.cdate,
    date: r.date || '',
    month: r.month || '',
    eventDate: r.eventDate || '',
    calYr: r.calYr,
    fy: r.fy || (r.fyEnd ? `FY${String(r.fyEnd).slice(-2)}` : ''),
    fyEnd: Number(r.fyEnd) || 0,
    isTailor: !!r.isTailor,
    partner: r.partner || (r.isTailor ? 'The Tailor' : 'Speaker bureaus'),
    won: r.won === true || r.status === 1,
  }));

  return {
    deals,
    meta: {
      status: deals.length ? 'live' : 'pending',
      source: SRC,
      note: deals.length ? null : 'No indirect deals found in ac_indirect_deals.',
    },
  };
}
