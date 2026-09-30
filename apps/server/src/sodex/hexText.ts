/**
 * Hex <-> UTF-8 for ABI strings, without Node's Buffer, so the on-chain
 * registry readers run in the browser too. Same results as
 * `Buffer.from(hex, 'hex').toString('utf8')` / `Buffer.from(s).toString('hex')`
 * for everything a registry returns (invalid UTF-8 becomes U+FFFD in both).
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** Hex (no 0x) to bytes; stops at the first byte that is not two hex digits, as Buffer does. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const byte = Number.parseInt(clean.slice(i, i + 2), 16);
    if (!/^[0-9a-fA-F]{2}$/.test(clean.slice(i, i + 2)) || Number.isNaN(byte)) break;
    out.push(byte);
  }
  return Uint8Array.from(out);
}

export const hexToUtf8 = (hex: string): string => decoder.decode(hexToBytes(hex));

export const utf8ToHex = (s: string): string =>
  Array.from(encoder.encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

export const utf8ByteLength = (s: string): number => encoder.encode(s).length;
