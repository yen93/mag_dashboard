// Login-code lifecycle — issue and verify the short email codes for the
// passwordless sign-in, persisted in the Supabase `dashboard_login_codes` table
// so they survive restarts and work across multiple Cloud Run instances.
//
// Codes are stored only as bcrypt hashes (never plaintext). Each code is
// 6 digits, valid 10 minutes, single-use, and capped at 5 verify attempts.

import bcrypt from 'bcryptjs';
import { q } from '../providers/supabase.js';

const CODE_TTL_MINUTES = 10;
const RESEND_THROTTLE_SECONDS = 60;
const MAX_ATTEMPTS = 5;

function generateCode() {
  // 6-digit, zero-padded (000000–999999).
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

function normalize(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Create and persist a fresh login code for `email`, returning the plaintext
 * code (for the mailer only — never sent to the client).
 *
 * Throttles resends and invalidates any earlier unconsumed codes for the email.
 * Returns `null` if a code was issued less than RESEND_THROTTLE_SECONDS ago, so
 * the caller can treat it as "already sent, try again shortly".
 */
export async function createCode(email) {
  const addr = normalize(email);

  // Throttle: bail if an unconsumed, unexpired code was just issued.
  const recent = await q(
    `select 1 from dashboard_login_codes
      where email = $1 and consumed = false and expires_at > now()
        and created_at > now() - ($2 || ' seconds')::interval
      limit 1`,
    [addr, String(RESEND_THROTTLE_SECONDS)]
  );
  if (recent.length > 0) return null;

  // Invalidate any prior outstanding codes for this email.
  await q(
    `update dashboard_login_codes set consumed = true
      where email = $1 and consumed = false`,
    [addr]
  );

  const code = generateCode();
  const codeHash = bcrypt.hashSync(code, 10);
  await q(
    `insert into dashboard_login_codes (email, code_hash, expires_at)
      values ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [addr, codeHash, String(CODE_TTL_MINUTES)]
  );
  return code;
}

/**
 * Verify `code` for `email`. Returns true and consumes the code on success;
 * otherwise increments the attempt counter and returns false.
 */
export async function verifyCode(email, code) {
  const addr = normalize(email);
  if (!code) return false;

  const rows = await q(
    `select id, code_hash, attempts from dashboard_login_codes
      where email = $1 and consumed = false and expires_at > now()
      order by created_at desc
      limit 1`,
    [addr]
  );
  if (rows.length === 0) return false;

  const row = rows[0];
  if (row.attempts >= MAX_ATTEMPTS) return false;

  if (!bcrypt.compareSync(String(code), row.code_hash)) {
    await q(`update dashboard_login_codes set attempts = attempts + 1 where id = $1`, [row.id]);
    return false;
  }

  await q(`update dashboard_login_codes set consumed = true where id = $1`, [row.id]);
  return true;
}
