// User model for the passwordless (email-code) sign-in.
//
// There is no user table: anyone with an @myadventuregroup.com.au email can
// sign in once they prove ownership via the emailed code. A user record is
// derived on the fly from the verified email address. A small allowlist keeps
// the `admin` role for specific addresses; everyone else is a `viewer`.

const ALLOWED_DOMAIN = 'myadventuregroup.com.au';

const ADMIN_EMAILS = [
  'julienne@myadventuregroup.com.au',
  'admin@myadventuregroup.com.au',
];

function normalize(email) {
  return String(email || '').trim().toLowerCase();
}

/** True iff `email` is a plausible address on the allowed company domain. */
export function isAllowedEmail(email) {
  const addr = normalize(email);
  // local-part@domain, where the domain is exactly the allowed one.
  return new RegExp(`^[^@\\s]+@${ALLOWED_DOMAIN.replace(/\./g, '\\.')}$`).test(addr);
}

/** Title-case a local-part ("mary.jane" / "mary_jane" -> "Mary Jane"). */
function nameFromEmail(addr) {
  const local = addr.split('@')[0] || '';
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || addr;
}

/**
 * Derive a user record from a verified email. Assumes `isAllowedEmail` already
 * passed. `id` is the normalized email (stable identifier for the JWT `sub`).
 */
export function userFromEmail(email) {
  const addr = normalize(email);
  return {
    id: addr,
    name: nameFromEmail(addr),
    email: addr,
    role: ADMIN_EMAILS.includes(addr) ? 'admin' : 'viewer',
  };
}

/** Public view of a user. */
export function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}
