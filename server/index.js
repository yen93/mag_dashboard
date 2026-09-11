import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter, requireAuth } from './auth.js';
import { getSales } from './data/sales.js';
import { getMarketing } from './data/marketing.js';
import { getOperations } from './data/operations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Health check (useful for Cloud Run / uptime checks).
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Auth routes: /api/login, /api/me
app.use('/api', authRouter);

// Protected metrics routes.
const metrics = express.Router();
metrics.use(requireAuth);
metrics.get('/sales', (req, res) => res.json(getSales(req.query.range)));
metrics.get('/marketing', (req, res) => res.json(getMarketing(req.query.range)));
metrics.get('/operations', (req, res) => res.json(getOperations(req.query.range)));
app.use('/api/metrics', metrics);

// Serve the plain HTML/CSS/JS pages from public/.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Root -> the first dashboard page (which bounces to login if not signed in).
app.get('/', (_req, res) => res.redirect('/sales.html'));

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
