import bcrypt from 'bcryptjs';

/**
 * Seed users for the mockup. Passwords are defined in plaintext here for
 * convenience and hashed with bcrypt at module load, so the login flow uses a
 * real hash comparison (never a plaintext compare). For production these would
 * move to a real user store and the plaintext seeds would be removed.
 */
const SEED = [
  {
    id: 1,
    name: 'Julienne (Admin)',
    email: 'admin@myadventuregroup.com.au',
    password: 'admin123',
    role: 'admin',
  },
  {
    id: 2,
    name: 'Sales Manager',
    email: 'sales@myadventuregroup.com.au',
    password: 'sales123',
    role: 'viewer',
  },
  {
    id: 3,
    name: 'Marketing Lead',
    email: 'marketing@myadventuregroup.com.au',
    password: 'marketing123',
    role: 'viewer',
  },
];

const users = SEED.map(({ password, ...rest }) => ({
  ...rest,
  passwordHash: bcrypt.hashSync(password, 10),
}));

export function findUserByEmail(email) {
  if (!email) return undefined;
  const needle = String(email).trim().toLowerCase();
  return users.find((u) => u.email.toLowerCase() === needle);
}

export function verifyPassword(user, password) {
  if (!user || !password) return false;
  return bcrypt.compareSync(password, user.passwordHash);
}

/** Public view of a user (never expose the hash). */
export function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}
