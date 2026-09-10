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

// Serve the built React frontend (produced by `npm run build`).
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));

// SPA fallback: any non-API route returns index.html so client-side routing works.
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) res.status(404).send('Frontend not built. Run `npm run build`.');
  });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
