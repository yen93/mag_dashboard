import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter, requireAuth } from './auth.js';
import { getSales } from './metrics/sales.js';
import { getMarketing } from './metrics/marketing.js';
import { getOperations } from './metrics/operations.js';
import { cached } from './lib/cache.js';
import { normalizeRange } from './lib/range.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Health check (useful for Cloud Run / uptime checks).
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Auth routes: /api/login, /api/me
app.use('/api', authRouter);

// Protected metrics routes. Each area is composed from live data providers,
// cached briefly per (area,range) so repeated loads don't re-hit the APIs.
const composers = { sales: getSales, marketing: getMarketing, operations: getOperations };
const metrics = express.Router();
metrics.use(requireAuth);
metrics.get('/:area', async (req, res) => {
  const composer = composers[req.params.area];
  if (!composer) return res.status(404).json({ error: 'Unknown metrics area.' });
  const range = normalizeRange(req.query.range);
  try {
    const payload = await cached(`${req.params.area}:${range}`, () => composer(range));
    res.json(payload);
  } catch (err) {
    console.error(`[metrics:${req.params.area}]`, err);
    res.status(502).json({ error: 'Failed to load metrics from data source.', detail: err.message });
  }
});
app.use('/api/metrics', metrics);

// Serve the plain HTML/CSS/JS pages from public/.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Root -> the first dashboard page (which bounces to login if not signed in).
app.get('/', (_req, res) => res.redirect('/sales.html'));

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
