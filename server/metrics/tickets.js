// server/metrics/tickets.js
// Internal ticketing / feedback board behind the AI & Automation > Ticketing page
// (public/ticketing.html, /api/tickets). Unlike most metric modules this one both
// READS and WRITES public.dashboard_tickets live over the pooled pg connection:
//   - any signed-in full-access team member can FILE a ticket (insert),
//   - admins TRIAGE it (update status/priority/assignee/admin_notes).
// There is no sync routine and no edge function — the table is owned by this feature.

import { q } from '../providers/supabase.js';

export const TICKET_TYPES = ['issue', 'feedback', 'build_feedback', 'build_request', 'check_in', 'other'];
export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

// Fortnightly team check-in tickets (public/checkin.html → POST /api/checkin) are
// filed ANONYMOUSLY: we deliberately discard the signed-in user's identity and
// stamp every check-in with this generic submitter, so candid feedback can't be
// traced back. (The route still requires a valid login — internal team only.)
const CHECKIN_SUBMITTER_EMAIL = 'team-checkin@myadventuregroup.com.au';
const CHECKIN_SUBMITTER_NAME = 'Team check-in (anonymous)';

function clip(v, max) {
  const s = (v == null ? '' : String(v)).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** Shape a DB row for the API (camelCase, ISO dates). */
function toApi(r) {
  return {
    id: r.id,
    ticketType: r.ticket_type,
    title: r.title,
    description: r.description || '',
    relatedBuild: r.related_build || '',
    priority: r.priority,
    status: r.status,
    submittedByEmail: r.submitted_by_email,
    submittedByName: r.submitted_by_name || '',
    assignee: r.assignee || '',
    adminNotes: r.admin_notes || '',
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

/** List every ticket (newest first) + summary counts for the KPI tiles. */
export async function getTickets() {
  const rows = await q(
    `select id, ticket_type, title, description, related_build, priority, status,
            submitted_by_email, submitted_by_name, assignee, admin_notes,
            created_at, updated_at
       from public.dashboard_tickets
      order by created_at desc`
  );
  const tickets = rows.map(toApi);

  const summary = {
    total: tickets.length,
    open: 0,
    in_progress: 0,
    resolved: 0,
    closed: 0,
    urgent_open: 0,
  };
  for (const t of tickets) {
    if (summary[t.status] !== undefined) summary[t.status] += 1;
    if ((t.status === 'open' || t.status === 'in_progress') && t.priority === 'urgent') {
      summary.urgent_open += 1;
    }
  }

  return { tickets, summary, lastPolledAt: new Date().toISOString() };
}

/**
 * File a new ticket. `user` is the verified JWT user (never trust the body for
 * identity). Returns the created ticket. Throws Error with `.status` for a 400.
 */
export async function createTicket(user, body) {
  body = body || {};
  const ticketType = String(body.ticketType || '').trim();
  const title = clip(body.title, 200);
  const description = clip(body.description, 8000);
  const relatedBuild = clip(body.relatedBuild, 200);
  let priority = String(body.priority || 'medium').trim();

  if (!TICKET_TYPES.includes(ticketType)) {
    const err = new Error('A valid ticket type is required.');
    err.status = 400;
    throw err;
  }
  if (!title) {
    const err = new Error('A title is required.');
    err.status = 400;
    throw err;
  }
  if (!TICKET_PRIORITIES.includes(priority)) priority = 'medium';

  const rows = await q(
    `insert into public.dashboard_tickets
       (ticket_type, title, description, related_build, priority,
        submitted_by_email, submitted_by_name)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, ticket_type, title, description, related_build, priority, status,
               submitted_by_email, submitted_by_name, assignee, admin_notes,
               created_at, updated_at`,
    [
      ticketType,
      title,
      description || null,
      relatedBuild || null,
      priority,
      user.email,
      user.name || null,
    ]
  );
  return toApi(rows[0]);
}

// Sentiment choices the check-in form may send (optional). Maps the stored value
// to a readable label for the ticket body.
const CHECKIN_SENTIMENTS = {
  great: '😄 Great',
  good: '🙂 Good',
  okay: '😐 Okay',
  rough: '😟 Rough',
};

/**
 * File an ANONYMOUS fortnightly team check-in as a `check_in` ticket. There is no
 * `user` argument on purpose — identity is never recorded (see CHECKIN_SUBMITTER_*).
 * `body` carries the form answers; every field is optional, but at least one of the
 * three main free-text answers (or an "anything else") must be present. Returns the
 * created ticket. Throws Error with `.status = 400` when the submission is empty.
 */
export async function createCheckin(body) {
  body = body || {};

  const sentimentKey = String(body.sentiment || '').trim();
  const sentiment = CHECKIN_SENTIMENTS[sentimentKey] || '';
  const working = clip(body.working, 4000);
  const notWorking = clip(body.notWorking, 4000);
  const improve = clip(body.improve, 4000);
  const anythingElse = clip(body.anythingElse, 4000);
  const area = clip(body.area, 120);

  // Needs-attention flag bumps priority; otherwise these are low-urgency pulse-checks.
  const priority = body.needsAttention ? 'high' : 'low';

  if (!working && !notWorking && !improve && !anythingElse && !sentiment) {
    const err = new Error('Please fill in at least one part of the check-in.');
    err.status = 400;
    throw err;
  }

  // Readable date for the title (AU/Manila-ish — just a human stamp, not tz-critical).
  const dateStr = new Date().toLocaleDateString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
  const title = `Fortnightly check-in — ${area || 'General'} · ${dateStr}`;

  // Compose a single readable description from the sections the person filled in.
  const parts = [];
  if (sentiment) parts.push(`Overall this fortnight: ${sentiment}`);
  if (working) parts.push(`✅ What's working well:\n${working}`);
  if (notWorking) parts.push(`⚠️ What's not working / blockers:\n${notWorking}`);
  if (improve) parts.push(`💡 Where we can improve / ideas:\n${improve}`);
  if (anythingElse) parts.push(`📝 Anything else:\n${anythingElse}`);
  const description = clip(parts.join('\n\n'), 8000);

  const rows = await q(
    `insert into public.dashboard_tickets
       (ticket_type, title, description, related_build, priority,
        submitted_by_email, submitted_by_name)
     values ('check_in', $1, $2, $3, $4, $5, $6)
     returning id, ticket_type, title, description, related_build, priority, status,
               submitted_by_email, submitted_by_name, assignee, admin_notes,
               created_at, updated_at`,
    [
      title,
      description || null,
      area || null,
      priority,
      CHECKIN_SUBMITTER_EMAIL,
      CHECKIN_SUBMITTER_NAME,
    ]
  );
  return toApi(rows[0]);
}

/**
 * Triage an existing ticket (admins only — the route enforces that). Only the
 * fields present in `body` are updated. Returns the updated ticket, or null if
 * the id doesn't exist. Throws Error with `.status` for an invalid value.
 */
export async function updateTicket(id, body) {
  body = body || {};
  const sets = [];
  const params = [];
  let i = 1;

  if (body.status !== undefined) {
    const status = String(body.status).trim();
    if (!TICKET_STATUSES.includes(status)) {
      const err = new Error('Invalid status.');
      err.status = 400;
      throw err;
    }
    sets.push(`status = $${i++}`); params.push(status);
  }
  if (body.priority !== undefined) {
    const priority = String(body.priority).trim();
    if (!TICKET_PRIORITIES.includes(priority)) {
      const err = new Error('Invalid priority.');
      err.status = 400;
      throw err;
    }
    sets.push(`priority = $${i++}`); params.push(priority);
  }
  if (body.assignee !== undefined) {
    sets.push(`assignee = $${i++}`); params.push(clip(body.assignee, 200) || null);
  }
  if (body.adminNotes !== undefined) {
    sets.push(`admin_notes = $${i++}`); params.push(clip(body.adminNotes, 8000) || null);
  }

  if (sets.length === 0) {
    const err = new Error('No updatable fields supplied.');
    err.status = 400;
    throw err;
  }

  params.push(id);
  const rows = await q(
    `update public.dashboard_tickets
        set ${sets.join(', ')}
      where id = $${i}
     returning id, ticket_type, title, description, related_build, priority, status,
               submitted_by_email, submitted_by_name, assignee, admin_notes,
               created_at, updated_at`,
    params
  );
  return rows.length ? toApi(rows[0]) : null;
}
