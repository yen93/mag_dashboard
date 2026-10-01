import jwt from 'jsonwebtoken';
import { Router } from 'express';
import { isAllowedEmail, userFromEmail, publicUser } from './users.js';
import { createCode, verifyCode } from './lib/loginCodes.js';
import { sendLoginCode } from './lib/mailer.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
const TOKEN_TTL = process.env.JWT_TTL || '8h';

if (!process.env.JWT_SECRET) {
  console.warn(
    '[auth] JWT_SECRET is not set — using an insecure development default. ' +
      'Set JWT_SECRET in the environment for any real deployment.'
  );
}

export const authRouter = Router();

// POST /api/request-code  { email } -> { ok: true }
// Emails a short sign-in code to any @myadventuregroup.com.au address.
authRouter.post('/request-code', async (req, res) => {
  const { email } = req.body || {};
  if (!isAllowedEmail(email)) {
    return res.status(400).json({ error: 'Use your @myadventuregroup.com.au email address.' });
  }
  try {
    const code = await createCode(email);
    // `null` means a code was just sent (throttled) — treat as success so we
    // neither resend nor leak timing; the earlier code is still valid.
    if (code) await sendLoginCode(email, code);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth] request-code failed:', err.message);
    return res.status(500).json({ error: 'Could not send the code, please try again.' });
  }
});

// POST /api/verify-code  { email, code } -> { token, user }
authRouter.post('/verify-code', async (req, res) => {
  const { email, code } = req.body || {};
  if (!isAllowedEmail(email)) {
    return res.status(400).json({ error: 'Use your @myadventuregroup.com.au email address.' });
  }
  let ok = false;
  try {
    ok = await verifyCode(email, code);
  } catch (err) {
    console.error('[auth] verify-code failed:', err.message);
    return res.status(500).json({ error: 'Could not verify the code, please try again.' });
  }
  if (!ok) {
    return res.status(401).json({ error: 'Invalid or expired code.' });
  }
  const user = userFromEmail(email);
  const token = jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
  return res.json({ token, user: publicUser(user) });
});

// Middleware: require a valid Bearer token.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// GET /api/me -> current user (from token)
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.sub, email: req.user.email, name: req.user.name, role: req.user.role } });
});
