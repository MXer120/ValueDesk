#!/usr/bin/env node
// Encryption of the off-server backups (backup-offsite.sh, backup-restore.sh,
// deploy/release/pull-backups.sh). Node only - no age, no gpg, no zstd binary needed,
// so a backup also opens on the owner's laptop.
//
//   backup-crypt.mjs keygen <keyfile>                 a new random key (0600; never overwrites)
//   backup-crypt.mjs id <keyfile>                     the key's id (16 hex) - safe to print
//   backup-crypt.mjs encrypt <keyfile> [--zstd] [--sha-out=<file>] [--plain-sha-out=<file>]  < in > out
//   backup-crypt.mjs decrypt <keyfile>                < in > out   (exit 1: wrong key or damaged)
//   backup-crypt.mjs info                             < in         version, compression, key id
//   backup-crypt.mjs cat [--rate=<MB/s>]              < in > out   a copy at most that fast
//
// FORMAT (version 1): a 28-byte header - "VDBK", version 1, flags (1 = zstd inside),
// two zero bytes, the key id (8 bytes), a random 12-byte IV - then the AES-256-GCM
// ciphertext of the (optionally zstd-compressed) data, then GCM's 16-byte tag. The
// header is the GCM additional data, so it cannot be changed unnoticed either.
// Authenticated: a wrong key or a single flipped bit fails the WHOLE file at the end,
// so decrypt into a temporary file and keep it only when this exits 0 (the callers do).
//
// THE KEY FILE: 32 random bytes as 64 hex characters (lines starting with # are
// comments). Each server has its own (/etc/valuescan/offsite/backup.key) and the
// server that RECEIVES the copies never has it: a stolen receiver holds nothing
// readable. The owner keeps both keys offline as well - without them no off-server
// copy can be opened (docs/deploy/BACKUPS.md).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import zlib from 'node:zlib';

const MAGIC = Buffer.from('VDBK');
const VERSION = 1;
const HEADER = 28;
const TAG = 16;
const FLAG_ZSTD = 1;

export function readKey(file) {
  const text = readFileSync(file, 'utf8');
  const hex = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).join('');
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${file} is not a backup key (64 hex characters)`);
  return Buffer.from(hex, 'hex');
}

/** 8 bytes that name a key without revealing it. */
export const keyId = (key) => createHash('sha256').update('valuedesk-backup-key-id\0').update(key).digest().subarray(0, 8);

function zstd(kind) {
  const make = kind === 'compress' ? zlib.createZstdCompress : zlib.createZstdDecompress;
  if (typeof make !== 'function') throw new Error('this Node has no zstd in zlib (Node 22.15 or newer is needed)');
  return kind === 'compress' ? make({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }) : make();
}

const hashing = (hash) => new Transform({ transform(chunk, _e, done) { hash.update(chunk); done(null, chunk); } });

/** The encrypting stream: header first, ciphertext, tag at the end. */
export function encryptStream(key, { compressed = false } = {}) {
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION, compressed ? FLAG_ZSTD : 0, 0, 0]), keyId(key), iv]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  let started = false;
  return new Transform({
    transform(chunk, _e, done) {
      const out = cipher.update(chunk);
      if (!started) {
        started = true;
        return done(null, Buffer.concat([header, out]));
      }
      done(null, out);
    },
    flush(done) {
      const fin = cipher.final();
      done(null, Buffer.concat([started ? Buffer.alloc(0) : header, fin, cipher.getAuthTag()]));
    },
  });
}

export function parseHeader(buf) {
  if (buf.length < HEADER || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('not a ValueDesk backup (no VDBK header)');
  if (buf[4] !== VERSION) throw new Error(`backup format version ${buf[4]} is not known here`);
  return { version: buf[4], compressed: (buf[5] & FLAG_ZSTD) !== 0, keyId: buf.subarray(8, 16).toString('hex'), iv: buf.subarray(16, 28), header: buf.subarray(0, HEADER) };
}

/** The decrypting stream: holds back the last 16 bytes (the tag) until the end. */
export function decryptStream(key, onHeader = () => {}) {
  let head = Buffer.alloc(0);
  let decipher = null;
  let tail = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _e, done) {
      try {
        if (!decipher) {
          head = Buffer.concat([head, chunk]);
          if (head.length < HEADER) return done();
          const h = parseHeader(head);
          if (h.keyId !== keyId(key).toString('hex')) throw new Error(`this backup was made with another key (id ${h.keyId}, this key is ${keyId(key).toString('hex')})`);
          onHeader(h);
          decipher = createDecipheriv('aes-256-gcm', key, h.iv);
          decipher.setAAD(h.header);
          chunk = head.subarray(HEADER);
        }
        const all = Buffer.concat([tail, chunk]);
        if (all.length <= TAG) {
          tail = all;
          return done();
        }
        tail = all.subarray(all.length - TAG);
        done(null, decipher.update(all.subarray(0, all.length - TAG)));
      } catch (e) {
        done(e);
      }
    },
    flush(done) {
      try {
        if (!decipher || tail.length !== TAG) throw new Error('the backup is cut short');
        decipher.setAuthTag(tail);
        done(null, decipher.final());
      } catch (e) {
        done(e.message?.includes('authenticate') ? new Error('authentication failed: wrong key, or the file is damaged') : e);
      }
    },
  });
}

/** Passes data on at most `mbps` megabytes a second (0 = no limit). */
export function throttle(mbps) {
  const rate = Number(mbps) > 0 ? Number(mbps) * 1e6 : 0;
  const t0 = Date.now();
  let sent = 0;
  return new Transform({
    transform(chunk, _e, done) {
      sent += chunk.length;
      if (!rate) return done(null, chunk);
      const wait = (sent / rate) * 1000 - (Date.now() - t0);
      if (wait > 5) setTimeout(() => done(null, chunk), wait);
      else done(null, chunk);
    },
  });
}

// --- command line ----------------------------------------------------------------------------------
const isMain = Boolean(process.argv[1]) && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name) => rest.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  const val = (name) => flag(name)?.split('=').slice(1).join('=');
  const file = rest.find((a) => !a.startsWith('--'));
  const fail = (msg, code = 1) => {
    console.error(`backup-crypt: ${msg}`);
    process.exit(code);
  };
  try {
    if (cmd === 'keygen') {
      if (!file) fail('usage: keygen <keyfile>', 2);
      if (existsSync(file)) fail(`${file} exists - a key is never overwritten (every backup made with it would be lost)`);
      const key = randomBytes(32);
      writeFileSync(file, `# ValueDesk backup key, id ${keyId(key).toString('hex')}, made ${new Date().toISOString()}. Keep a copy OFFLINE.\n${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
      console.log(keyId(key).toString('hex'));
    } else if (cmd === 'id') {
      if (!file) fail('usage: id <keyfile>', 2);
      console.log(keyId(readKey(file)).toString('hex'));
    } else if (cmd === 'encrypt') {
      if (!file) fail('usage: encrypt <keyfile> [--zstd] [--sha-out=<file>] [--plain-sha-out=<file>]', 2);
      const key = readKey(file);
      const plain = createHash('sha256');
      const out = createHash('sha256');
      const stages = [process.stdin, hashing(plain)];
      if (flag('zstd')) stages.push(zstd('compress'));
      stages.push(encryptStream(key, { compressed: Boolean(flag('zstd')) }), hashing(out), process.stdout);
      await pipeline(stages);
      if (val('sha-out')) writeFileSync(val('sha-out'), `${out.digest('hex')}\n`);
      if (val('plain-sha-out')) writeFileSync(val('plain-sha-out'), `${plain.digest('hex')}\n`);
    } else if (cmd === 'decrypt') {
      if (!file) fail('usage: decrypt <keyfile> < in > out', 2);
      const key = readKey(file);
      // The header says whether a decompressor follows: read it first, then put it back in front.
      const it = process.stdin[Symbol.asyncIterator]();
      let head = Buffer.alloc(0);
      while (head.length < HEADER) {
        const { value, done } = await it.next();
        if (done) break;
        head = Buffer.concat([head, value]);
      }
      const h = parseHeader(head);
      const src = Readable.from((async function* () {
        yield head;
        for (;;) {
          const { value, done } = await it.next();
          if (done) return;
          yield value;
        }
      })());
      const stages = [src, decryptStream(key)];
      if (h.compressed) stages.push(zstd('decompress'));
      stages.push(process.stdout);
      await pipeline(stages);
    } else if (cmd === 'info') {
      const chunks = [];
      let n = 0;
      for await (const c of process.stdin) {
        chunks.push(c);
        n += c.length;
        if (n >= HEADER) break;
      }
      const h = parseHeader(Buffer.concat(chunks));
      console.log(JSON.stringify({ version: h.version, compressed: h.compressed, keyId: h.keyId }));
    } else if (cmd === 'cat') {
      await pipeline(process.stdin, throttle(val('rate') ?? 0), process.stdout);
    } else {
      fail('usage: keygen | id | encrypt | decrypt | info | cat (see the top of this file)', 2);
    }
  } catch (e) {
    fail(e?.message ?? String(e));
  }
}
