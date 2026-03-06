import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null | undefined;
function getKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const hex = process.env.ENCRYPTION_KEY;
  cachedKey = (hex && hex.length === 64) ? Buffer.from(hex, 'hex') : null;
  return cachedKey;
}

export function isEncryptionEnabled(): boolean {
  return getKey() !== null;
}

export function encrypt(plaintext: string): { ciphertext: string; iv: string } {
  const key = getKey();
  if (!key) throw new Error('ENCRYPTION_KEY not set or invalid (need 64 hex chars)');

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
  };
}

export function decrypt(ciphertext: string, iv: string): string {
  const key = getKey();
  if (!key) throw new Error('ENCRYPTION_KEY not set or invalid (need 64 hex chars)');

  const buf = Buffer.from(ciphertext, 'base64');
  const ivBuf = Buffer.from(iv, 'base64');
  const tag = buf.subarray(buf.length - TAG_LEN);
  const data = buf.subarray(0, buf.length - TAG_LEN);

  const decipher = createDecipheriv(ALGO, key, ivBuf, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
