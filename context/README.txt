# context/ — per-page dev reference for the MAG Metrics Dashboard

These files hold the detailed, page-by-page knowledge that used to live inline in the root
CLAUDE.md. CLAUDE.md now keeps only the always-apply rules + a map pointing here, so it stays
small enough for the instruction-file size limit.

HOW TO USE
- Before working on a page/tab, open its file (the map is in root CLAUDE.md, "Context map").
- Each file is the SINGLE SOURCE OF TRUTH for that page: when you change the page, update its
  file here — do NOT grow CLAUDE.md.
- Content is extracted verbatim from CLAUDE.md history, so wording, dates and "as of" notes are
  preserved; prune superseded history in-place when you touch a file.

LAYOUT
  shared/        cross-cutting: navigation, architecture, design-system, data-pipeline,
                 auth-access, deploy
  marketing/     one file per Marketing tab + ga4-leads-tracker (GA4 & Ads Leads Tracking)
  sales/         overview (top-line + Conferences), education-outreach, education-leads,
                 alternate-leads
  operations/    overview (incl. Buyer Analysis + Invoices)
  ai-automation/ ticketing, checkin

Filenames deliberately avoid words the repo .gitignore blocks (secret/credential/password/
token/cookie/apikey), so every file here is tracked by git.
