/**
 * Generate a bcrypt hash for the dashboard password and a fresh
 * HMAC session secret. Run this once and copy the outputs into your `.env`.
 *
 * Usage:
 *   bun run scripts/hash-password.ts <password>
 *
 * Output (paste into .env):
 *   DASHBOARD_PASSWORD_HASH=$2b$10$...
 *   DASHBOARD_SESSION_SECRET=<64 hex chars>
 *
 * Notes:
 *   - The session secret is only printed when not already set in the env so
 *     re-running the script for a new password does not invalidate every
 *     existing dashboard session unless you copy the new secret too.
 *   - Bun.password.hash uses bcrypt with cost 10 (≈100 ms). If Bun.password
 *     is unavailable for any reason, the script falls back to node:crypto's
 *     scrypt (still salted, still slow, format prefixed with `scrypt$`).
 */

import { randomBytes, scryptSync } from 'node:crypto';

async function hashWithBun(password: string): Promise<string | null> {
  try {
    const fn = (Bun as any)?.password?.hash;
    if (typeof fn !== 'function') return null;
    return await fn(password, { algorithm: 'bcrypt', cost: 10 });
  } catch (err) {
    console.warn('[hash-password] Bun.password.hash failed, falling back to scrypt:', err);
    return null;
  }
}

function hashWithScrypt(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function main() {
  const password = process.argv[2];
  if (!password) {
    console.error('Usage: bun run scripts/hash-password.ts <password>');
    process.exit(1);
  }

  const hash = (await hashWithBun(password)) ?? hashWithScrypt(password);
  console.log('');
  console.log('# --- Paste these lines into your .env (do NOT commit) ---');
  console.log(`DASHBOARD_PASSWORD_HASH=${hash}`);
  if (!process.env.DASHBOARD_SESSION_SECRET) {
    const secret = randomBytes(32).toString('hex');
    console.log(`DASHBOARD_SESSION_SECRET=${secret}`);
  } else {
    console.log('# DASHBOARD_SESSION_SECRET already set in env — keeping existing value.');
  }
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
