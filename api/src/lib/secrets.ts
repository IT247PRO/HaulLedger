// AES-GCM encryption for per-carrier integration secrets. The key is a platform
// secret (wrangler secret put INTEGRATIONS_KEY): 32 random bytes, base64.
import { HTTPException } from 'hono/http-exception';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(raw: string | undefined): Promise<CryptoKey> {
  if (!raw) throw new HTTPException(501, { message: 'Integrations are not configured: set INTEGRATIONS_KEY with `wrangler secret put` (32 random bytes, base64).' });
  const bytes = unb64(raw);
  if (bytes.length !== 32) throw new HTTPException(500, { message: 'INTEGRATIONS_KEY must be 32 bytes (base64)' });
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(rawKey: string | undefined, plaintext: string, aad: string): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, await key(rawKey), new TextEncoder().encode(plaintext));
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

/** `aad` binds the ciphertext to its tenant and provider, so a row copied elsewhere will not decrypt. */
export async function decryptSecret(rawKey: string | undefined, iv: string, ct: string, aad: string): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(aad) }, await key(rawKey), unb64(ct));
  return new TextDecoder().decode(pt);
}
