/** Fresh secp256k1 signing keys. Shared by enrolment (routes/wallet.ts) and
 *  just-in-time elevation (elevation.ts) so both mint keys the same way. */
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { privateKeyToAddress } from './signing/eip712.js';

export function generateKey(): { privateKey: string; address: string } {
  for (;;) {
    const buf = randomBytes(32);
    if (secp256k1.utils.isValidSecretKey?.(buf) ?? true) {
      try {
        return { privateKey: '0x' + buf.toString('hex'), address: privateKeyToAddress(buf) };
      } catch {
        /* astronomically unlikely; retry */
      }
    }
  }
}
