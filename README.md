# MAG Metrics Dashboard (mockup)

An internal dashboard for **Sales**, **Marketing**, and **Operations** metrics.
It's a real app, not a static page: tabbed navigation, interactive toggles
(date range, light/dark theme, per-chart series and chart/table views), and
**JWT login**. Data is currently **seeded mock data** — the API surface is shaped
so live sources (Stripe, Xero, ActiveCampaign, monday.com) can be swapped in
later without touching the frontend.

## Stack
- **Backend:** Node + Express, `jsonwebtoken`, `bcryptjs` — serves the API and
  the static pages from a single origin.
- **Frontend:** plain, hand-editable HTML/CSS/JS — **no build step**. Charts use a
  locally-vendored Chart.js (`public/vendor/chart.umd.min.js`).
- **Deploy:** one container on **Google Cloud Run** (scales to zero → ~free for a mockup).

## Project layout
```
server/           Express API (auth + mock metrics) and static file server
  data/           deterministic mock-metric generators (sales/marketing/operations)
public/           the editable frontend — one HTML file per screen
  login.html      login page
  sales.html      \
  marketing.html   } dashboard pages (each = top bar + tabs + its own content)
  operations.html /
  app.css         shared styling (edit CSS variables to restyle everything)
  app.js          shared logic: auth, data fetch, formatting, chart helpers
  vendor/         Chart.js (vendored locally, no CDN needed)
Dockerfile        single-stage (no frontend build — public/ is served as-is)
```

### Editing the pages
Open any file in `public/` and edit it directly — the HTML holds the page
structure/labels, `app.css` holds all styling, and each page's inline `<script>`
maps API data onto its charts and tables. No compile step; just save and refresh.

## Demo logins
| Email | Password | Role |
|-------|----------|------|
| admin@myadventuregroup.com.au | `admin123` | admin |
| sales@myadventuregroup.com.au | `sales123` | viewer |
| marketing@myadventuregroup.com.au | `marketing123` | viewer |

These are defined in `server/users.js` (passwords are bcrypt-hashed at startup).

## Run locally
Requires Node 20+.

```bash
npm install    # server deps only
npm run dev    # nodemon: restarts the server on change, serves on :8080
```
Open http://localhost:8080. (Editing files in `public/` needs no restart — just
refresh the browser. `npm start` runs the server without nodemon.)

## Environment variables
| Var | Purpose | Default |
|-----|---------|---------|
| `JWT_SECRET` | Signing secret for JWTs. **Set this in any deployment.** | insecure dev default (warns) |
| `JWT_TTL` | Token lifetime | `8h` |
| `PORT` | Port to listen on (Cloud Run sets this) | `8080` |

## Deploy to Cloud Run
One-time setup (replace `PROJECT_ID`):
```bash
gcloud auth login
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

Deploy from source (Cloud Build builds the Dockerfile, then deploys):
```bash
gcloud run deploy dashboard \
  --source . \
  --region australia-southeast1 \
  --allow-unauthenticated \
  --set-env-vars JWT_SECRET="$(openssl rand -hex 32)"
```
The command prints an HTTPS URL. `--allow-unauthenticated` is correct here: the
app enforces its own JWT login, so the login screen is the gate. The service
scales to zero when idle, so a low-traffic mockup stays within the always-free tier.

### Rotate the JWT secret
```bash
gcloud run services update dashboard --region australia-southeast1 \
  --set-env-vars JWT_SECRET="$(openssl rand -hex 32)"
```
(Rotating invalidates existing tokens — users simply log in again.) For a real
deployment, store the secret in Secret Manager and reference it with
`--set-secrets JWT_SECRET=JWT_SECRET:latest` instead of an env var.

## Going live with real data
Replace the generator functions in `server/data/{sales,marketing,operations}.js`
with calls to the real sources. Keep the same response shape (`kpis`,
`timeseries`, etc.) and the pages and auth need no changes.
