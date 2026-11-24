// Marketing — Indirect Deals.
//
// Reads public.ac_indirect_deals (rebuilt/upserted by the ac-bureau-deals-sync edge function).
// Backs the "Indirect Deals" table on public/email_partners.html (/api/marketing/indirect-deals).

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC = 'Supabase public.ac_indirect_deals (ActiveCampaign indirect / bureau / tailor deals mirror)';

// Xero engagement fee per deal, summed across the deal's invoices (deposit + final)
// and keyed by AC deal title — IDENTICAL to the roas_counted_deals view's `xero` CTE,
// so Won revenue here reconciles with the buyer sheet / ROAS. A deal not yet invoiced
// in the 2026+ invoice_tracking cache comes back NULL, and the Won-revenue card falls
// back to the AC-contracted value.
const SQL = `
  WITH xero AS (
    SELECT ac_deal_title,
           round(sum(engagement_fee)::numeric, 2) AS engagement_fee
    FROM public.invoice_tracking
    WHERE ac_deal_title IS NOT NULL
    GROUP BY ac_deal_title
  )
  SELECT
    d.deal_id        AS "dealId",
    d.title,
    d.deal_source    AS "dealSource",
    d.pipeline_id    AS "pipelineId",
    d.pipeline_name  AS "pipelineName",
    d.stage_id       AS "stageId",
    d.status,
    d.status_label   AS "statusLabel",
    d.contact_id     AS "contactId",
    d.contact_name   AS "contactName",
    d.contact_email  AS "contactEmail",
    d.account_id     AS "accountId",
    d.organization,
    coalesce(nullif(d.organization, ''), d.contact_name) AS org,
    d.value_raw      AS "valueRaw",
    d.value_aud      AS "value",
    xt.engagement_fee AS "engagementFee",
    d.currency,
    d.cdate,
    to_char(d.cdate, 'YYYY-MM-DD') AS date,
    to_char(date_trunc('month', d.cdate), 'YYYY-MM') AS month,
    d.mdate,
    d.event_date     AS "eventDate",
    d.cal_yr         AS "calYr",
    d.fy,
    (extract(year from d.cdate)::int + case when extract(month from d.cdate) >= 7 then 1 else 0 end) AS "fyEnd",
    d.is_tailor      AS "isTailor",
    CASE WHEN d.is_tailor THEN 'The Tailor' ELSE 'Speaker bureaus' END AS partner,
    (d.status = 1)   AS won
  FROM public.ac_indirect_deals d
  LEFT JOIN xero xt ON xt.ac_deal_title = d.title
  WHERE d.cdate IS NOT NULL
  ORDER BY d.cdate DESC`;

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
    contactId: r.contactId == null ? null : String(r.contactId),
    contactName: r.contactName || '',
    contactEmail: r.contactEmail || '',
    contact: r.contactName || r.contactEmail || '',
    organization: r.organization || '',
    org: r.org || '',
    value: n(r.value),
    // Xero engagement fee where the deal has been invoiced, else null (card falls back to `value`).
    engagementFee: r.engagementFee == null ? null : Number(r.engagementFee),
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
