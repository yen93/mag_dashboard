// MAG GA4 Agent — on-demand GA4 reports via the "GA4 On-Demand Report" Claude routine.
//
// Flow (no secrets ever reach the browser):
//   1. POST /api/ga4-agent/run { prompt }
//        -> insert a 'pending' row into public.ga4_agent_requests
//        -> fire the routine (server-side, with the secret token)
//        -> return { id }
//   2. The routine claims the row, runs scripts/ga4_routine.py in the cloud
//      (GA4 key held in the routine's cloud environment), writes the markdown
//      result back onto the row, and marks it 'done'.
//   3. GET /api/ga4-agent/result?id=... -> the browser polls until status='done'.
//
// The Supabase table is the shared hand-off, mirroring the sales-topline-sync /
// invoice-tracking pattern (routine writes a table; dashboard only reads/writes rows).

import { Router } from 'express';
import { requireAuth } from './auth.js';
import { config, hasSource } from './config.js';
import { q, supabaseConfigured } from './providers/supabase.js';

export const ga4AgentRouter = Router();
ga4AgentRouter.use(requireAuth);

const MAX_PROMPT = 2000;

// Submit a question and trigger the routine.
ga4AgentRouter.post('/run', async (req, res) => {
  const prompt = String((req.body && req.body.prompt) || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Enter a question first.' });
  if (prompt.length > MAX_PROMPT) {
    return res.status(400).json({ error: `Question is too long (max ${MAX_PROMPT} characters).` });
  }
  if (!supabaseConfigured()) {
    return res.status(503).json({ error: 'Storage not configured (SUPABASE_DB_URL).' });
  }
  if (!hasSource('ga4Agent')) {
    return res.status(503).json({ error: 'GA4 agent not configured (GA4_ROUTINE_FIRE_URL / GA4_ROUTINE_FIRE_TOKEN).' });
  }

  let id;
  try {
    const rows = await q(
      `INSERT INTO public.ga4_agent_requests (prompt, status, requested_by)
       VALUES ($1, 'pending', $2) RETURNING id`,
      [prompt, (req.user && req.user.email) || null]
    );
    id = rows[0].id;
  } catch (err) {
    console.error('[ga4-agent] insert failed', err.message);
    return res.status(502).json({ error: 'Could not queue the request.' });
  }

  // Fire the routine. The token stays server-side.
  try {
    const r = await fetch(config.ga4Agent.fireUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.ga4Agent.fireToken,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: '{}',
    });
    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 300);
      console.error('[ga4-agent] fire failed', r.status, detail);
      await q(
        `UPDATE public.ga4_agent_requests SET status='error',
         error=$1, updated_at=now() WHERE id=$2`,
        [`Could not start the GA4 agent (HTTP ${r.status}).`, id]
      ).catch(() => {});
      return res.status(502).json({ error: 'Could not start the GA4 agent. Please try again.' });
    }
  } catch (err) {
    console.error('[ga4-agent] fire error', err.message);
    await q(
      `UPDATE public.ga4_agent_requests SET status='error', error=$1, updated_at=now() WHERE id=$2`,
      ['Could not reach the GA4 agent.', id]
    ).catch(() => {});
    return res.status(502).json({ error: 'Could not reach the GA4 agent. Please try again.' });
  }

  res.json({ id });
});

// Poll for the result.
ga4AgentRouter.get('/result', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing id.' });
  if (!supabaseConfigured()) {
    return res.status(503).json({ error: 'Storage not configured (SUPABASE_DB_URL).' });
  }
  try {
    const rows = await q(
      `SELECT id, status, result, error, prompt, created_at, updated_at
       FROM public.ga4_agent_requests WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Request not found.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[ga4-agent] result failed', err.message);
    res.status(502).json({ error: 'Could not read the result.' });
  }
});
