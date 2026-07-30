import { randomBytes, randomInt } from 'node:crypto';

// Crockford base32: no I, L, O or U, so IDs survive being read aloud or
// retyped without ambiguity.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number, length: number): string {
  let remaining = ms;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out = ALPHABET[remaining % 32]! + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % 32]!;
  }
  return out;
}

/**
 * A ULID-shaped identifier: 10 chars of timestamp then 16 of randomness.
 *
 * Lexicographic order matches creation order, which means `ORDER BY id` is a
 * usable stable tiebreaker and new rows append to the end of B-tree indexes
 * instead of scattering through them.
 */
export function newId(): string {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}

/** URL-safe opaque token — session cookies, invite codes. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * A short human-typeable invite code, e.g. `K7QM-2XPD-9NRT`.
 *
 * Grouped and drawn from the unambiguous alphabet because these get read out
 * over voice chat.
 */
export function newInviteCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 3; g += 1) {
    let group = '';
    for (let i = 0; i < 4; i += 1) group += ALPHABET[randomInt(ALPHABET.length)]!;
    groups.push(group);
  }
  return groups.join('-');
}

/** Lowercase, hyphenated, collision-free-ish slug for category URLs. */
export function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || `c-${encodeRandom(6).toLowerCase()}`;
}
