// Education Sector Outreach — the Sales tab's cold-outreach tracker for schools
// and education associations.
//
// Data sources (all Supabase, plain SELECTs — no external API calls at request
// time, so a short cache is plenty):
//   • public.manually_found_educ_leads  — one row per prospect (contact, account,
//       school/association, workflow status code, follow-up send dates, thread_id).
//   • public.educ_processed_messages    — the inbox-watcher log; a row with
//       action='responded' on a lead's thread_id means that lead REPLIED.
//   • public.status                     — the workflow status-code dictionary
//       (e.g. "2B" = "2nd email sent", "8A" = "received a lead response",
//       "10A" = "Delivery has failed"). Single source of truth for the labels.
//
// Everything below is derived from those three tables; no numbers are hard-coded.

import { q, supabaseConfigured } from '../providers/supabase.js';

const SRC = 'Supabase → manually_found_educ_leads + educ_processed_messages (joined to the status dictionary)';

// Status-code buckets (from public.status):
//   1A/2A/3A/4A/9A = Nth email DRAFTED (not yet sent)
//   1B/2B/3B/4B/9B = Nth email SENT
//   5A = skipped · 6A = Archived (Unresponsive) · 7A = deleted
//   8A = received a lead response (RESPONDED) · 10A = Delivery has failed (BOUNCED)
const SENT_CODES = new Set(['1B', '2B', '3B', '4B', '9B']);
const DRAFTED_CODES = new Set(['1A', '2A', '3A', '4A', '9A']);
// Codes where the INITIAL email was never actually sent (so it doesn't count toward
// "emails sent"): 1A = 1st email only drafted; 5A = the lead was skipped.
const NO_INITIAL_CODES = new Set(['1A', '5A']);

const STATUS_SQL = `SELECT status, description FROM public.status`;

const LEADS_SQL = `
  SELECT
    l.id,
    l.email,
    l.firstname,
    l.lastname,
    l.role,
    l.account,
    l.status,
    NULLIF(btrim(l.school_or_association), '') AS kind,
    l.created_at,
    l.followup_1_date_sent,
    l.followup_2_date_sent,
    l.followup_3_date_sent,
    r.responded_at
  FROM public.manually_found_educ_leads l
  LEFT JOIN LATERAL (
    SELECT max(m.processed_at) AS responded_at
    FROM public.educ_processed_messages m
    WHERE m.thread_id = l.thread_id AND m.action = 'responded'
  ) r ON TRUE`;

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const maxTs = (arr) => {
  let best = null;
  for (const v of arr) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (!best || t > new Date(best).getTime()) best = v;
  }
  return best;
};

function classify(row, descByCode) {
  const code = row.status || null;
  const followups = [row.followup_1_date_sent, row.followup_2_date_sent, row.followup_3_date_sent].filter(Boolean);
  const followupCount = followups.length;
  const initialSent = !!code && !NO_INITIAL_CODES.has(code);
  const emailsSent = followupCount + (initialSent ? 1 : 0);

  const responded = code === '8A' || !!row.responded_at;
  const bounced = code === '10A';

  let stage, stageLabel;
  if (responded) { stage = 'responded'; stageLabel = 'Responded'; }
  else if (bounced) { stage = 'bounced'; stageLabel = 'Bounced (delivery failed)'; }
  else if (code === '6A') { stage = 'archived'; stageLabel = 'Archived — unresponsive'; }
  else if (code === '7A') { stage = 'deleted'; stageLabel = 'Deleted'; }
  else if (code === '5A') { stage = 'skipped'; stageLabel = 'Skipped'; }
  else if (SENT_CODES.has(code)) { stage = 'in_sequence'; stageLabel = 'In sequence'; }
  else if (DRAFTED_CODES.has(code)) { stage = 'drafted'; stageLabel = 'Drafted (not sent)'; }
  else { stage = 'other'; stageLabel = 'Other'; }

  const lastEmailSent = followupCount ? maxTs(followups) : (initialSent ? row.created_at : null);
  const name = [row.firstname, row.lastname].map((s) => (s || '').trim()).filter(Boolean).join(' ') || row.email;

  return {
    id: row.id,
    name,
    email: row.email,
    role: row.role || '',
    account: row.account || '',
    kind: row.kind || 'unknown',              // 'school' | 'association'
    statusCode: code || '',
    statusDesc: (code && descByCode[code]) || '',
    stage,
    stageLabel,
    emailsSent,
    followupCount,
    lastEmailSent,
    responded,
    respondedAt: row.responded_at || null,
    bounced,
    createdAt: row.created_at,
  };
}

export async function getEducationOutreach() {
  if (!supabaseConfigured()) return notConfigured();

  const [statusRows, leadRows] = await Promise.all([q(STATUS_SQL, []), q(LEADS_SQL, [])]);

  const descByCode = {};
  for (const s of statusRows) descByCode[s.status] = s.description;

  const leads = leadRows.map((row) => classify(row, descByCode));

  // ---- aggregates -----------------------------------------------------------
  const total = leads.length;
  const contacted = leads.filter((l) => l.emailsSent >= 1).length;
  const responded = leads.filter((l) => l.responded).length;
  const bounced = leads.filter((l) => l.bounced).length;
  const inSequence = leads.filter((l) => l.stage === 'in_sequence').length;
  const archived = leads.filter((l) => l.stage === 'archived').length;
  const delivered = leads.filter((l) => l.emailsSent >= 1 && !l.bounced).length;
  const schools = leads.filter((l) => l.kind === 'school').length;
  const associations = leads.filter((l) => l.kind === 'association').length;

  const replyRate = delivered > 0 ? r1((responded / delivered) * 100) : null;
  const bounceRate = contacted > 0 ? r1((bounced / contacted) * 100) : null;
  const contactedPct = total > 0 ? r1((contacted / total) * 100) : null;
  const totalEmails = leads.reduce((a, l) => a + l.emailsSent, 0);
  const avgEmails = contacted > 0 ? r1(totalEmails / contacted) : null;

  // ---- funnel (conversion through the outreach) ------------------------------
  const funnel = [
    { stage: 'Leads added', value: total },
    { stage: 'Emails delivered', value: delivered },
    { stage: 'Responses', value: responded },
  ];

  // ---- current-status breakdown (for the doughnut) --------------------------
  const STAGE_ORDER = [
    ['in_sequence', 'In sequence'],
    ['responded', 'Responded'],
    ['bounced', 'Bounced'],
    ['drafted', 'Drafted'],
    ['archived', 'Archived'],
    ['skipped', 'Skipped'],
    ['deleted', 'Deleted'],
    ['other', 'Other'],
  ];
  const stageCounts = {};
  leads.forEach((l) => { stageCounts[l.stage] = (stageCounts[l.stage] || 0) + 1; });
  const statusBreakdown = STAGE_ORDER
    .filter(([k]) => (stageCounts[k] || 0) > 0)
    .map(([k, label]) => ({ stage: k, label, value: stageCounts[k] }));

  // ---- raw status-code tally (handy for the AI snapshot) --------------------
  const codeCounts = {};
  leads.forEach((l) => {
    const k = l.statusCode || '(none)';
    codeCounts[k] = (codeCounts[k] || 0) + 1;
  });
  const statusDetail = Object.keys(codeCounts)
    .map((code) => ({ code, description: descByCode[code] || '', count: codeCounts[code] }))
    .sort((a, b) => b.count - a.count);

  const lastActivityAt = maxTs(leads.flatMap((l) => [l.createdAt, l.lastEmailSent, l.respondedAt]));

  return {
    asOf: new Date().toISOString(),
    lastActivityAt,
    meta: { status: 'live', source: SRC },
    cards: {
      total, contacted, contactedPct, responded, replyRate,
      bounced, bounceRate, inSequence, archived, delivered,
      avgEmails, schools, associations,
    },
    funnel,
    statusBreakdown,
    statusDetail,
    leads,
  };
}

function notConfigured() {
  return {
    asOf: new Date().toISOString(),
    lastActivityAt: null,
    meta: { status: 'pending', source: SRC, note: 'Supabase not configured (set SUPABASE_DB_URL).' },
    cards: {
      total: 0, contacted: 0, contactedPct: null, responded: 0, replyRate: null,
      bounced: 0, bounceRate: null, inSequence: 0, archived: 0, delivered: 0,
      avgEmails: null, schools: 0, associations: 0,
    },
    funnel: [], statusBreakdown: [], statusDetail: [], leads: [],
  };
}
