/**
 * The admin suite's password (admin/auth.ts), set by the owner ON THE SERVER:
 *
 *   sudo bash /opt/valuescan/bin/admin-password.sh          set or change it (asked twice, nothing shown)
 *   sudo bash /opt/valuescan/bin/admin-password.sh --status whether one is set, and since when
 *   sudo bash /opt/valuescan/bin/admin-password.sh --off    turn the suite off (the hash is kept aside)
 *
 * The password is read from the terminal with echo off - never from an argument,
 * the environment, a pipe or a file - and only its scrypt hash is written. Setting
 * or changing it, or turning it off, signs every admin session out, and is written
 * to the admin audit log.
 */
import { existsSync, renameSync, statSync } from 'node:fs';
import { AdminStore } from '../src/admin/store.js';
import { PASSWORD_MIN, adminPasswordPath, hashPassword, writePasswordHash } from '../src/admin/auth.js';

const path = adminPasswordPath();
const arg = process.argv[2] ?? '';

function ask(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('run this in a terminal: the password is typed, never piped or passed in'));
      return;
    }
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let s = '';
    const done = (err?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(s);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003' || ch === '\u0004') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1);
        else if (ch >= ' ') s += ch;
      }
    };
    input.on('data', onData);
  });
}

function signOutEveryone(kind: string): void {
  const store = new AdminStore();
  const ended = store.endAllSessions();
  store.audit({ kind, ok: true, detail: { ended } });
  store.close();
  console.log(`admin sessions signed out: ${ended}`);
}

async function main(): Promise<void> {
  if (arg === '--status') {
    if (!existsSync(path)) return void console.log(`no admin password: the suite is off (${path})`);
    console.log(`admin password set ${new Date(statSync(path).mtimeMs).toISOString()} (${path})`);
    return;
  }
  if (arg === '--off') {
    if (!existsSync(path)) return void console.log('no admin password: the suite is off already');
    const aside = `${path}.off-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(path, aside);
    signOutEveryone('password.off');
    console.log(`the admin suite is off; the old hash is kept at ${aside}`);
    return;
  }
  if (arg) throw new Error(`unknown argument ${arg} (none, --status or --off)`);
  console.log(`The admin suite's password (at least ${PASSWORD_MIN} characters). Nothing is shown while you type.`);
  const first = await ask('New password: ');
  if (first.length < PASSWORD_MIN) throw new Error(`too short: at least ${PASSWORD_MIN} characters`);
  const second = await ask('Again: ');
  if (first !== second) throw new Error('the two did not match - nothing changed');
  writePasswordHash(await hashPassword(first), path);
  signOutEveryone('password.set');
  console.log(`admin password set (${path}). Signing in at https://dev.valuedesk.so needs the builder wallet's signature too.`);
}

main().catch((e: unknown) => {
  console.error(`admin-password: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
