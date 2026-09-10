# CLAUDE.md — MAG Metrics Dashboard

Internal Sales/Marketing/Operations metrics dashboard. React (Vite) frontend +
Express API in **one** deployable service, JWT login, **mock data** (no DB yet).
Deployed on Google Cloud Run.

## Architecture (the non-obvious bits)
- **Single origin.** `server/index.js` serves both `/api/*` and the built React
  app from `client/dist`, with a SPA fallback (`/^(?!\/api).*/` → `index.html`).
  There is no separate frontend host — the client and API always share an origin,
  in dev (via Vite proxy) and in production (Express serves the build).
- **ESM everywhere** on the server (`"type": "module"` in root package.json) —
  use `import`, not `require`.
- **Mock data is deterministic.** `server/data/util.js` uses a seeded PRNG so a
  given date always yields the same numbers. Metric generators return a fixed
  shape (`{ range, kpis, timeseries, ... }`). To go live, replace the bodies of
  `server/data/{sales,marketing,operations}.js` but KEEP the response shape — the
  frontend and auth need no changes.
- **Auth.** `server/users.js` seeds users and bcrypt-hashes their passwords at
  module load (never a plaintext compare). `server/auth.js` issues/verifies JWTs
  with `JWT_SECRET`. Frontend keeps the token in `localStorage` (`src/api.js`),
  decodes it client-side for the user chip (`src/auth/AuthContext.jsx`), and a
  401 from the API triggers sign-out → redirect to `/login`.

## Build / run
- Dev: `npm install` + `npm --prefix client install`, then `npm run dev`
  (Express :8080, Vite :5173 proxying `/api`). Open http://localhost:5173.
- Prod path (what the container runs): `npm run build` then `npm start` (:8080).
  Always test this path before deploying — it's the real Cloud Run behavior.
- `npm run build` = `npm --prefix client install && vite build` → `client/dist`.

## Deploy (Cloud Run)
- `gcloud run deploy dashboard --source . --region australia-southeast1
  --allow-unauthenticated --set-env-vars JWT_SECRET=<secret>`
  (Cloud Build builds the Dockerfile; the multi-stage image builds the client
  then runs the server on Node 20 alpine.)
- Project `claudegwscli-502400`. Live URL:
  https://dashboard-659687081407.australia-southeast1.run.app
- **gcloud is NOT on PATH by default** on this machine (installed via winget).
  Full path: `C:\Users\Cloverly\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`.
  A fresh terminal picks it up on PATH; an already-open one may not.
- `--allow-unauthenticated` is intentional — the JWT login is the gate. To lock
  down further, remove it and use IAM / domain restriction.

## Gotchas
- **Env vars:** `JWT_SECRET` MUST be set in any deployment (server warns + uses an
  insecure dev default otherwise). The production value lives at
  `%TEMP%\mag_jwt_secret.txt`, not in the repo. `JWT_TTL` default 8h; `PORT`
  default 8080 (Cloud Run sets it).
- **Windows/shells:** the `!` in-session prompt runs **Bash**, not PowerShell —
  don't use PowerShell `&`/`$` call syntax there. This repo's tooling otherwise
  runs fine from PowerShell using the full gcloud.cmd path.
- No lockfile-strict installs: Dockerfile uses `npm install` (not `npm ci`).

## Demo logins
admin@myadventuregroup.com.au / admin123 (also sales@ / sales123,
marketing@ / marketing123). Defined in `server/users.js`.
