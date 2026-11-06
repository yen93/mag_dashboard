// linkedin-newsletter-sync — weekly pull of LinkedIn newsletter subscriber count(s).
//
// The subscriber count is login-gated (only shown to signed-in members), but it IS
// present in the newsletter page's embedded JSON. This function fetches the page with
// a cookie-authenticated request (li_at session cookie), regexes out `subscriberCount`,
// and UPSERTS public.content_social_metrics. No headless browser / no Apify needed.
//
// ⚠ This is automated access with a LinkedIn session cookie (crosses LinkedIn's User
// Agreement). Use a DEDICATED account's cookie. From a datacenter IP LinkedIn is more
// likely to challenge the request than from a residential IP — if it does, the fetch
// returns an auth/challenge page with no count, which this function treats as a failure
// (it alerts and leaves the stored value unchanged).
//
// Invoke: ?dry=1 (fetch + parse, report, no write) · ?sync=1 (write) · bare (bg 202).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LINKEDIN_LI_AT (+ GMAIL_* for alerts).
// Deploy --no-verify-jwt (the pg_cron/pg_net call carries no auth header).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LI_AT = (Deno.env.get("LINKEDIN_LI_AT") ?? "").trim();

const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
const ALERT_EMAIL = Deno.env.get("ALERT_EMAIL") ?? "julienne@myadventuregroup.com.au";

const UA = Deno.env.get("LI_USER_AGENT") ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Newsletters to track (metric_key ↔ URL). Add more rows here as needed.
const NEWSLETTERS = [
  {
    metric_key: "li_newsletter_subscribers_james",
    label: "Newsletter subscribers",
    url: Deno.env.get("LI_NEWSLETTER_URL_JAMES") ??
      "https://www.linkedin.com/newsletters/7358785085849919488/",
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });

type Pull = { metric_key: string; label: string; url: string; count: number | null; http: number; bytes: number; wall: boolean; error?: string };

async function pull(n: { metric_key: string; label: string; url: string }): Promise<Pull> {
  const res: Pull = { ...n, count: null, http: 0, bytes: 0, wall: false };
  try {
    const r = await fetch(n.url, {
      headers: {
        Cookie: `li_at=${LI_AT}`,
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    const html = await r.text();
    res.http = r.status;
    res.bytes = html.length;
    res.wall = /authwall|auth_wall|session_redirect|checkpoint\/challenge|security verification|add to your feed to see/i.test(html);
    // subscriberCount is embedded in the page JSON, HTML-entity-encoded (&quot;) or plain.
    const matches = [...html.matchAll(/subscriberCount(?:&quot;|")\s*:\s*(\d+)/g)].map((m) => parseInt(m[1], 10));
    res.count = matches.length ? matches[0] : null;
    if (res.count == null) res.error = res.wall ? "login/challenge wall — no count in page" : "subscriberCount not found in page";
  } catch (err) {
    res.error = err instanceof Error ? err.message : String(err);
  }
  return res;
}

type Summary = {
  fn: string;
  as_of: string;
  pulls: Pull[];
  written: number;
  dry: boolean;
  ok: boolean;
  error: string | null;
};

async function sendFailureEmail(summary: Summary, detail: string): Promise<void> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error("[linkedin-newsletter-sync] alert email NOT sent — GMAIL creds not set");
    return;
  }
  const client = new SMTPClient({
    connection: { hostname: "smtp.gmail.com", port: 465, tls: true,
      auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD } },
  });
  try {
    await client.send({
      from: GMAIL_USER,
      to: ALERT_EMAIL,
      subject: "⚠️ linkedin-newsletter-sync FAILED (cookie likely expired)",
      content: "auto",
      html: `<p>The <b>linkedin-newsletter-sync</b> function could not read the newsletter
        subscriber count — most likely the <code>LINKEDIN_LI_AT</code> cookie expired or LinkedIn
        challenged the request. The stored value was <b>NOT</b> changed.</p>
        <p>Refresh the cookie: log into the dedicated LinkedIn account, copy a fresh
        <code>li_at</code>, and update the <code>LINKEDIN_LI_AT</code> edge secret.</p>
        <p><b>Error:</b></p><pre>${detail.replace(/[<>&]/g, (c) =>
          ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string))}</pre>
        <p><b>Summary:</b></p><pre>${JSON.stringify(summary, null, 2)}</pre>
        <p>Ran at ${new Date().toISOString()}</p>`,
    });
  } finally {
    await client.close();
  }
}

async function run(dry: boolean): Promise<Summary> {
  const as_of = new Date().toISOString().slice(0, 10);
  const summary: Summary = { fn: "linkedin-newsletter-sync", as_of, pulls: [], written: 0, dry, ok: false, error: null };
  try {
    if (!LI_AT) throw new Error("Missing LINKEDIN_LI_AT");
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

    summary.pulls = await Promise.all(NEWSLETTERS.map(pull));
    const good = summary.pulls.filter((p) => p.count != null);

    // Guard: if nothing parsed, treat as failure (cookie expired / challenged) and don't write.
    if (good.length === 0) {
      throw new Error("No subscriber counts parsed — " + summary.pulls.map((p) => `${p.metric_key}: ${p.error} (http ${p.http})`).join("; "));
    }

    if (dry) {
      summary.ok = true;
      console.log("[linkedin-newsletter-sync] DRY:", JSON.stringify(summary));
      return summary;
    }

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    for (const p of good) {
      const { error } = await db.from("content_social_metrics").upsert({
        metric_key: p.metric_key,
        label: p.label,
        value: p.count,
        unit: "subscribers",
        source: "linkedin-cookie",
        as_of,
        updated_at: new Date().toISOString(),
      }, { onConflict: "metric_key" });
      if (error) throw new Error(`upsert ${p.metric_key} failed: ${error.message}`);
      summary.written += 1;
    }

    summary.ok = true;
    console.log("[linkedin-newsletter-sync] done:", JSON.stringify(summary));
    return summary;
  } catch (err) {
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : String(err);
    console.error("[linkedin-newsletter-sync] FAILED:", summary.error);
    if (!dry) {
      try { await sendFailureEmail(summary, summary.error); }
      catch (mailErr) { console.error("[linkedin-newsletter-sync] alert email failed:", mailErr); }
    }
    return summary;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const sync = url.searchParams.get("sync") === "1";
  if (dry || sync) {
    const res = await run(dry);
    return json(res, res.ok ? 200 : 500);
  }
  if (EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(run(false));
    return json({ message: "linkedin-newsletter-sync started in background", timestamp: new Date().toISOString() }, 202);
  }
  const res = await run(false);
  return json(res, res.ok ? 200 : 500);
});
