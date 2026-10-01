// Mailer — sends the passwordless login codes over Gmail SMTP.
//
// Uses a single lazily-created nodemailer transport (same lazy-singleton shape
// as the pg pool in server/providers/supabase.js). Authenticates as the Gmail
// (Google Workspace) account in config with an app password.
//
// When email isn't configured (no GMAIL_APP_PASSWORD), we don't hard-fail — the
// code is logged to the console so local/dev work needs no real SMTP creds,
// matching the app's "a missing credential degrades, never breaks" convention.

import nodemailer from 'nodemailer';
import { config, hasSource } from '../config.js';

let transport = null;

function getTransport() {
  if (!hasSource('email')) {
    throw new Error('email is not configured (GMAIL_USER / GMAIL_APP_PASSWORD)');
  }
  if (!transport) {
    transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: config.email.gmailUser,
        pass: config.email.gmailAppPassword,
      },
    });
  }
  return transport;
}

/**
 * Email a sign-in code to `email`. Resolves once sent (or once logged, in the
 * dev fallback). Throws only if a configured transport fails to send.
 */
export async function sendLoginCode(email, code) {
  if (!hasSource('email')) {
    // Dev fallback: no SMTP creds — surface the code locally instead of sending.
    console.log(`[mailer] email not configured — login code for ${email}: ${code}`);
    return;
  }

  const from = `MAG Metrics <${config.email.gmailUser}>`;
  await getTransport().sendMail({
    from,
    to: email,
    subject: `${code} is your MAG Metrics sign-in code`,
    text:
      `Your MAG Metrics sign-in code is ${code}\n\n` +
      `It is valid for 10 minutes. If you didn't request it, you can ignore this email.`,
    html:
      `<p>Your MAG Metrics sign-in code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:12px 0">${code}</p>` +
      `<p style="color:#666">It is valid for 10 minutes. If you didn't request it, you can ignore this email.</p>`,
  });
}
