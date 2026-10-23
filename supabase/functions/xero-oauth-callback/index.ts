// xero-oauth-callback
// ---------------------------------------------------------------------------
// One-time OAuth2 authorization-code catcher for the FREE standard Xero app
// (used instead of a paid Custom Connection). Register this function's URL as
// the app's Redirect URI:
//   https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/xero-oauth-callback
//
// Flow: the user opens the authorize link, logs in, picks MyAdventure Group and
// clicks Allow. Xero redirects here with ?code=... . We exchange the code for an
// access + refresh token and store the REFRESH token in public.oauth_token_store
// (provider='xero'). xero-ad-spend-sync then reads/rotates it on every run.
//
// Secrets: XERO_CLIENT_ID, XERO_CLIENT_SECRET, SUPABASE_URL,
//          SUPABASE_SERVICE_ROLE_KEY, optional XERO_REDIRECT_URI (defaults below).
// Deploy with verify_jwt:false (Xero's redirect carries no Authorization header).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("XERO_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("XERO_CLIENT_SECRET") ?? "";
const REDIRECT_URI =
  Deno.env.get("XERO_REDIRECT_URI") ??
  "https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/xero-oauth-callback";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
// Xero split the broad accounting.transactions scope into granular ones for apps
// created from 2 Mar 2026; bank transactions now live under accounting.banktransactions.read.
const SCOPES = "offline_access accounting.banktransactions.read accounting.contacts.read";

const page = (msg: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Xero connect</title>` +
      `<body style="font:16px/1.5 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">${msg}</body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

Deno.serve(async (req: Request) => {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const err = u.searchParams.get("error");

  if (err) return page(`<h2>❌ Authorisation failed</h2><p>${err}</p>`, 400);
  if (!CLIENT_ID || !CLIENT_SECRET) return page(`<h2>Not configured</h2><p>XERO_CLIENT_ID / XERO_CLIENT_SECRET are not set.</p>`, 500);

  // No code yet → start the login: redirect to Xero's consent screen.
  // Build the query by hand: Xero needs spaces in `scope` as %20, but
  // URLSearchParams would encode them as "+", which Xero reads literally
  // (→ invalid_scope). encodeURIComponent gives %20.
  if (!code) {
    const qs = [
      "response_type=code",
      `client_id=${encodeURIComponent(CLIENT_ID)}`,
      `redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
      `scope=${encodeURIComponent(SCOPES)}`,
      `state=${crypto.randomUUID()}`,
    ].join("&");
    return new Response(null, { status: 302, headers: { Location: `${XERO_AUTHORIZE_URL}?${qs}` } });
  }

  const basic = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
  const r = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.refresh_token) {
    return page(`<h2>❌ Token exchange failed</h2><pre>${r.status} ${JSON.stringify(d).slice(0, 400)}</pre>`, 500);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { error } = await db
    .from("oauth_token_store")
    .upsert({ provider: "xero", refresh_token: d.refresh_token, updated_at: new Date().toISOString() }, { onConflict: "provider" });
  if (error) return page(`<h2>❌ Could not store token</h2><pre>${error.message}</pre>`, 500);

  return page(`<h2>✅ Xero connected</h2><p>You can close this tab. The ad-spend sync can now run.</p>`);
});
