/**
 * Session encryption and token hashing.
 * AES-256-GCM with a random IV for every record.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Sealed {
  /** Hex ciphertext and authentication tag separated by a colon. */
  data: string;
  /** hex */
  iv: string;
}

function deriveKey(secret: string): Buffer {
  if (!secret) throw new Error('encryption secret is empty');
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function seal(plaintext: string, secret: string): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv, { authTagLength: TAG_BYTES });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    data: `${encrypted.toString('hex')}:${cipher.getAuthTag().toString('hex')}`,
    iv: iv.toString('hex'),
  };
}

export function unseal(sealed: Sealed, secret: string): string {
  const [encryptedHex, tagHex] = sealed.data.split(':');
  if (encryptedHex === undefined || !tagHex) throw new Error('sealed value is malformed');
  const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), Buffer.from(sealed.iv, 'hex'), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
}

/** Random secret: user token, session encryption key, or export salt. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time hash comparison. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}
