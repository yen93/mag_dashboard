# CLAUDE.md — MAG Metrics Dashboard

Internal Sales/Marketing/Operations metrics dashboard. **Plain HTML/CSS/JS**
frontend (no build step) + Express API in one deployable service, JWT login,
**mock data** (no DB). Deployed on Google Cloud Run.

> History: this started as a React + Vite app, then was converted to plain
> editable HTML pages (so pages can be hand-edited without a build). There is no
> more `client/`, Vite, or Recharts.

## Architecture (the non-obvious bits)
- **Single origin.** `server/index.js` serves both `/api/*` and the static pages
  in `public/`. `/` redirects to `/sales.html`. No SPA fallback — each page is a
  real file.
- **Frontend = static files in `public/`, no build.** One HTML file per screen
  (`login.html`, `sales.html`, `marketing.html`, `operations.html`). The tab bar
  is just links between those pages. Shared styling in `public/app.css` (CSS
  variables drive theming). Shared logic in `public/app.js`. Each page has an
  inline `<script>` that calls `initPage(area, renderFn)` and maps API data onto
  charts/tables. **Do not add a bundler** — the point is hand-editability.
- **Charts:** Chart.js, vendored locally at `public/vendor/chart.umd.min.js`
  (loaded via `<script>` before `app.js`). No CDN dependency. `app.js` exposes
  `lineChart` / `barChart` / `pieChart` / `renderKpis` / `renderTable` helpers;
  charts read colors from CSS variables and are recreated on theme toggle.
  Series show/hide uses Chart.js's built-in legend click; chart/table view uses
  `wireViewToggle`.
- **ESM on the server** (`"type":"module"` in package.json) — use `import`.
- **Mock data is deterministic.** `server/data/util.js` seeded PRNG; generators
  in `server/data/{sales,marketing,operations}.js` return a fixed shape
  (`{ range, kpis, timeseries, ... }`). To go live, replace those bodies but KEEP
  the shape — the pages and auth need no changes.
- **Auth.** `server/users.js` seeds users, bcrypt-hashes passwords at load.
  `server/auth.js` issues/verifies JWTs with `JWT_SECRET`. Frontend keeps the
  token in `localStorage` (`app.js`), decodes it client-side for the user chip,
  and a 401 from the API triggers logout → `login.html`. Shared date range also
  persists in `localStorage` so it carries across pages.

## Build / run
- Local: `npm install` (server deps only), then `npm run dev` (nodemon on :8080)
  or `npm start`. Open http://localhost:8080. Editing `public/` files needs only
  a browser refresh, no restart.
- There is **no** `npm run build` and no client install step anymore.

## Deploy (Cloud Run)
- `gcloud run deploy dashboard --source . --region australia-southeast1
  --allow-unauthenticated --set-env-vars JWT_SECRET=<secret>`
  (single-stage Dockerfile: `npm install --omit=dev`, copy `server/` + `public/`,
  run the server on Node 20 alpine.)
- Project `claudegwscli-502400`. Live URL:
  https://dashboard-659687081407.australia-southeast1.run.app
- **gcloud is NOT on PATH by default** on this machine (installed via winget).
  Full path: `C:\Users\Cloverly\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`.
  A fresh terminal picks it up on PATH; an already-open one may not.
- `--allow-unauthenticated` is intentional — the JWT login is the gate.

## Gotchas
- **Env vars:** `JWT_SECRET` MUST be set in any deployment (server warns + uses an
  insecure dev default otherwise). The production value lives at
  `%TEMP%\mag_jwt_secret.txt`, not in the repo. `JWT_TTL` default 8h; `PORT`
  default 8080 (Cloud Run sets it).
- **Windows/shells:** the `!` in-session prompt runs **Bash**, not PowerShell —
  don't use PowerShell `&`/`$` call syntax there.
- **Leftover dev processes lock files.** A stray `vite`/`esbuild` from an old
  `npm run dev` can lock folders on Windows; kill the node/esbuild tree if a
  delete/rename fails with "resource busy".
- Dockerfile uses `npm install` (not `npm ci`); no lockfile-strict install.

## Demo logins
admin@myadventuregroup.com.au / admin123 (also sales@ / sales123,
marketing@ / marketing123). Defined in `server/users.js`.
