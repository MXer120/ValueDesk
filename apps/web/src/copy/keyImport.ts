/**
 * Bringing a SoDEX API key you made yourself to an executor: its private key,
 * encrypted to that executor before it leaves the browser (the executor's half
 * is apps/executor/src/secrets.ts, openImport).
 *
 * ECDH on P-256 between a one-time key made here and the executor's published
 * key (ExecutorInfo.keyImport.publicKey), HKDF-SHA256 over the shared secret
 * with the executor's info string (this executor and this wallet), and
 * AES-256-GCM. Only WebCrypto: the same code runs in the browser and in Node.
 */

export interface KeyImportEnvelope {
  /** The one-time public key, SPKI DER, base64url. */
  epk: string;
  /** AES-GCM IV, base64url. */
  iv: string;
  /** The ciphertext with its 16-byte tag at the end, base64url. */
  ct: string;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding (no btoa: not every runtime this package is built for types it). */
function b64u(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    if (i + 1 < b.length) out += ALPHABET[(n >> 6) & 63]!;
    if (i + 2 < b.length) out += ALPHABET[n & 63]!;
  }
  return out;
}

function fromB64u(s: string): ArrayBuffer {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let j = 0;
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch === '+' ? '-' : ch === '/' ? '_' : ch);
    if (v < 0) throw new Error('not base64url');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 255;
    }
  }
  return out.slice(0, j).buffer;
}

/** A copy of `b` in an ArrayBuffer of its own (what WebCrypto takes everywhere). */
const own = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

/** A private key as typed: 64 hex characters, with or without 0x. Null when it is not one. */
export function parsePrivateKey(text: string): Uint8Array | null {
  const h = text.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** `privateKey` sealed for the executor whose key-import key is `publicKey`, bound to `info` (with the owner filled in). */
export async function sealForImport(publicKey: string, info: string, privateKey: Uint8Array): Promise<KeyImportEnvelope> {
  const subtle = globalThis.crypto.subtle;
  // Keys typed by what the calls take (this package is also built without the DOM library).
  type Key = Parameters<typeof subtle.exportKey>[1];
  const theirs = await subtle.importKey('spki', fromB64u(publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const mine = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as unknown as { privateKey: Key; publicKey: Key };
  const shared = await subtle.deriveBits({ name: 'ECDH', public: theirs }, mine.privateKey, 256);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const aes = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: own(new TextEncoder().encode(info)) }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: own(iv) }, aes, own(privateKey));
  return { epk: b64u(await subtle.exportKey('spki', mine.publicKey)), iv: b64u(iv), ct: b64u(ct) };
}
