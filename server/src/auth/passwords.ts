import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Hand-rolled rather than promisify()'d: promisify resolves to the
// 3-argument overload of scrypt, which cannot pass the options object we need
// for the memory limit below.
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

// scrypt is in Node's standard library, so there is no native module to
// compile and no argon2 build step in the image. These parameters cost roughly
// 100 ms and 64 MB per hash, which is the right shape for a login form.
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;
// scrypt needs ~128 * N * r bytes; Node's default 32 MB cap rejects N=16384.
const MAX_MEMORY = 192 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password.normalize('NFKC'), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: MAX_MEMORY,
  })) as Buffer;

  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number.parseInt(parts[1]!, 10);
  const r = Number.parseInt(parts[2]!, 10);
  const p = Number.parseInt(parts[3]!, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = (await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAX_MEMORY,
    })) as Buffer;
  } catch {
    // Malformed stored parameters (e.g. an absurd N) — treat as a failed
    // login rather than a 500.
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Returns a human-readable reason the password is unacceptable, or null. */
export function validatePassword(password: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters.';
  if (password.length > 512) return 'Password must be under 512 characters.';
  // Deliberately no composition rules — length is what matters, and arbitrary
  // symbol requirements push people toward weaker, more predictable passwords.
  return null;
}

export function validateUsername(username: string): string | null {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{1,31}$/.test(username)) {
    return 'Username must be 2–32 characters: letters, numbers, underscore, dot or hyphen, starting with a letter, number or underscore.';
  }
  return null;
}
