// User model for the passwordless (email-code) sign-in.
//
// There is no user table: anyone with an allowed email can sign in once they
// prove ownership via the emailed code. A user record is derived on the fly from
// the verified email address. Roles:
//   - `admin`      — a small allowlist (ADMIN_EMAILS); full access + extra tools.
//   - `viewer`     — any other @myadventuregroup.com.au address; full read access.
//   - `restricted` — external partners (e.g. Simple Digital). May sign in but can
//                    ONLY see the Leads & Bookings and ROAS pages; every other page
//                    + API resource is blocked. See RESTRICTED_* below.

const ALLOWED_DOMAIN = 'myadventuregroup.com.au';

const ADMIN_EMAILS = [
  'julienne@myadventuregroup.com.au',
  'admin@myadventuregroup.com.au',
];

// Restricted (partner) access: allowed to sign in, but scoped to the Leads &
// Bookings and ROAS pages only. A whole domain and/or individual addresses can be listed.
const RESTRICTED_DOMAINS = [
  'simpledigital.net.au',
];
const RESTRICTED_EMAILS = [
  'testertwo.myadventuregroup@gmail.com',
];

// Beyond the admins, James (JC) may set the manual review tag on the GA4 & Ads
// Leads page even though his role is `viewer`.
const JC_REVIEW_EMAILS = [
  'james@myadventuregroup.com.au',
];

function normalize(email) {
  return String(email || '').trim().toLowerCase();
}

/** The domain part of a normalized address ("" if malformed). */
function domainOf(addr) {
  return addr.includes('@') ? addr.split('@')[1] : '';
}

/** True iff `email` is a well-formed restricted (partner) address. */
export function isRestrictedEmail(email) {
  const addr = normalize(email);
  if (!/^[^@\s]+@[^@\s]+$/.test(addr)) return false;
  return RESTRICTED_DOMAINS.includes(domainOf(addr)) || RESTRICTED_EMAILS.includes(addr);
}

/** True iff `email` is a plausible address allowed to sign in (company or partner). */
export function isAllowedEmail(email) {
  const addr = normalize(email);
  if (!/^[^@\s]+@[^@\s]+$/.test(addr)) return false;
  // local-part@domain, where the domain is exactly the allowed company one …
  if (domainOf(addr) === ALLOWED_DOMAIN) return true;
  // … or the address is on the restricted (partner) allowlist.
  return isRestrictedEmail(addr);
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
  let role = 'viewer';
  if (ADMIN_EMAILS.includes(addr)) role = 'admin';
  else if (isRestrictedEmail(addr)) role = 'restricted';
  return {
    id: addr,
    name: nameFromEmail(addr),
    email: addr,
    role,
  };
}

/** True iff `email` may set the JC manual review tag (admins + James). */
export function canReviewJc(email) {
  const addr = normalize(email);
  return ADMIN_EMAILS.includes(addr) || JC_REVIEW_EMAILS.includes(addr);
}

/** Public view of a user. */
export function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}
