// supabase/functions/fortnightly-checkin-email/index.ts
//
// Fortnightly Team Check-in invite. Emails EVERYONE in public.organization_users a
// link to the dashboard's Team Check-in form (AI & Automation > Team Check-in), so the
// team can proactively flag what's working, what's not, and where we can improve.
//
// Cadence: pg_cron fires this WEEKLY every Friday 14:00 Manila (06:00 UTC), but the
// function only actually sends on EVERY OTHER Friday — it gates on a fortnight anchor
// so the real cadence is fortnightly. (pg_cron can't express "every 2 weeks" directly.)
//
// Query modes:
//   ?dry=1    — preview recipients + due/not-due, send nothing
//   ?force=1  — bypass the fortnight gate (always treat as due); useful for testing
//   ?to=a@b   — send only to this one address (testing), instead of all org users
//
// Reads organization_users with the service role (bypasses RLS). Writes NOTHING.
// Degrades per-recipient: one bad address doesn't stop the rest.
//
// Deploy (MUST be --no-verify-jwt so the pg_cron/net.http_post call with no auth runs):
//   supabase functions deploy fortnightly-checkin-email --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

// Environment / Secrets
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";

// The live Team Check-in form (behind the dashboard login).
const CHECKIN_FORM_URL =
  Deno.env.get("CHECKIN_FORM_URL") ??
  "https://dashboard-659687081407.australia-southeast1.run.app/checkin.html";

// Fortnight anchor: a Friday on which a send is DUE. Weeks are counted from here; an
// even number of whole weeks since the anchor => due. Default 2026-11-20 (first send).
const CHECKIN_ANCHOR = Deno.env.get("CHECKIN_ANCHOR") ?? "2026-11-20";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

interface Recipient {
  email: string;
  firstName: string;
}

/** Whole weeks between the anchor Friday (UTC) and "today"; even => a send is due. */
function fortnightState(now: Date): { weeksSinceAnchor: number; due: boolean } {
  const anchor = new Date(`${CHECKIN_ANCHOR}T00:00:00Z`);
  const dayMs = 24 * 3600 * 1000;
  const days = Math.round((now.getTime() - anchor.getTime()) / dayMs);
  const weeksSinceAnchor = Math.floor(days / 7);
  // Even fortnights (0, 2, 4 …) are send weeks; before the anchor week, never due.
  const due = weeksSinceAnchor >= 0 && weeksSinceAnchor % 2 === 0;
  return { weeksSinceAnchor, due };
}

async function loadRecipients(toOverride: string | null): Promise<Recipient[]> {
  if (toOverride) return [{ email: toOverride, firstName: "" }];
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return [];

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await supabase
    .from("organization_users")
    .select("email, first_name, display_name");
  if (error) throw new Error(`organization_users read failed: ${error.message}`);

  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of data ?? []) {
    const email = String(r.email ?? "").trim();
    if (!email || !email.includes("@") || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    const firstName =
      String(r.first_name ?? "").trim() ||
      String(r.display_name ?? "").trim().split(" ")[0] ||
      "";
    out.push({ email, firstName });
  }
  return out;
}

function buildEmailHtml(firstName: string): string {
  const greeting = firstName ? `Hi ${firstName},` : "Hi there,";
  return `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"><title>MAG Fortnightly Team Check-in</title></head>
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #cbd5e1;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.06);">
          <tr>
            <td style="background:#0f172a;padding:22px 28px;">
              <div style="font-size:11px;text-transform:uppercase;color:#94a3b8;font-weight:700;letter-spacing:1px;">MyAdventure Group</div>
              <div style="font-size:20px;font-weight:700;color:#ffffff;margin-top:3px;">Fortnightly Team Check-in</div>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 28px 8px;">
              <p style="font-size:15px;margin:0 0 14px;">${greeting}</p>
              <p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 14px;">
                It's check-in time 🎉 Taking <strong>2 minutes</strong> to share how things are going helps us
                catch what's working, fix what's not, and spot where we can improve — together.
              </p>
              <p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 22px;">
                Your response is <strong>completely anonymous</strong> — we never record who submitted it, so
                please be candid.
              </p>
              <div style="text-align:center;margin:0 0 24px;">
                <a href="${CHECKIN_FORM_URL}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:13px 30px;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">
                  Open the check-in form &rarr;
                </a>
              </div>
              <p style="font-size:12.5px;line-height:1.5;color:#64748b;margin:0 0 6px;">
                You'll be asked to sign in with your MAG email first. Takes less time than a coffee ☕
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;padding:14px 28px;border-top:1px solid #e2e8f0;font-size:11.5px;color:#64748b;text-align:center;">
              Sent every second Friday by the MAG Metrics dashboard. If the button doesn't work, paste this into your browser:<br>
              <span style="color:#2563eb;word-break:break-all;">${CHECKIN_FORM_URL}</span>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
  </html>`;
}

/** Trim inter-tag whitespace to avoid MIME quoted-printable "=20" artifacts. */
function sanitizeEmailHtml(html: string): string {
  return html.split("\n").map((l) => l.trimEnd()).join("\n").replace(/>\s+</g, "><").trim();
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const force = url.searchParams.get("force") === "1";
  const toOverride = url.searchParams.get("to");

  const now = new Date();
  const { weeksSinceAnchor, due } = fortnightState(now);
  const shouldSend = force || due;

  try {
    const recipients = await loadRecipients(toOverride);

    const base = {
      ok: true,
      nowUtc: now.toISOString(),
      anchor: CHECKIN_ANCHOR,
      weeksSinceAnchor,
      dueThisFriday: due,
      forced: force,
      dryRun: dry,
      recipientCount: recipients.length,
      recipients: recipients.map((r) => r.email),
      formUrl: CHECKIN_FORM_URL,
    };

    // Not a send-week (and not forced): skip quietly — the weekly cron will no-op.
    if (!shouldSend) {
      return json({ ...base, sent: 0, skipped: "not-due", reason: "Off-week — not a fortnight boundary." });
    }

    if (dry) {
      return json({ ...base, sent: 0, skipped: "dry-run" });
    }

    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      return json({ ...base, sent: 0, error: "GMAIL_USER / GMAIL_APP_PASSWORD not set." }, 500);
    }
    if (recipients.length === 0) {
      return json({ ...base, sent: 0, error: "No recipients found in organization_users." }, 200);
    }

    const client = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD },
      },
    });

    const failed: { email: string; error: string }[] = [];
    let sent = 0;

    try {
      for (const r of recipients) {
        try {
          await client.send({
            from: `MAG Metrics <${GMAIL_USER}>`,
            to: r.email,
            subject: "🗓️ Your 2-minute fortnightly check-in",
            html: sanitizeEmailHtml(buildEmailHtml(r.firstName)),
          });
          sent++;
        } catch (err) {
          failed.push({ email: r.email, error: (err as Error).message || "send failed" });
        }
      }
    } finally {
      await client.close();
    }

    console.log(`[fortnightly-checkin-email] sent=${sent} failed=${failed.length}`);
    return json({ ...base, sent, failedCount: failed.length, failed });
  } catch (err) {
    console.error("[fortnightly-checkin-email] fatal:", err);
    return json({ ok: false, error: (err as Error).message || "Internal error" }, 500);
  }
});
