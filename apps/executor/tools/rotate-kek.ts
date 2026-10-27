/**
 * Rotate the executor's key-encryption key (src/rotation.ts has the whole procedure).
 *
 *   ... rotate-kek.ts check                   every sealed key opens under the kek file? (read-only;
 *                                             safe next to the running executor; exit 1 if not)
 *   ... rotate-kek.ts check --kek <file>      the same under another kek file (e.g. a kek.old-*)
 *   ... rotate-kek.ts rotate                  EXECUTOR STOPPED: a new kek, every key sealed again
 *                                             in one transaction, the old kek kept as kek.old-<stamp>
 *   ... rotate-kek.ts rotate --kek-from <f>   the same, but to the kek in <f> (undo: a kek.old-*)
 *
 * Run as the executor's user, from apps/executor (on the server:
 *   cd /opt/valuescan/current/apps/executor && sudo -u valuescan-executor \
 *     /opt/node/current/bin/node --disable-warning=ExperimentalWarning --import tsx tools/rotate-kek.ts check
 * deploy/server/bin/rotate-secret.sh executor-kek does all of it, stop and start included).
 *
 * Options: --dir <d> (default $EXECUTOR_DATA_DIR, else /var/lib/valuescan/executor), --network
 * mainnet|testnet (default $SODEX_NETWORK, else mainnet - the network is part of every sealed
 * record), --no-snapshot (skip executor.db.before-kek-<stamp>).
 *
 * Nothing secret is printed: keys are named by their id. AFTER A ROTATION the offline kek block
 * is out of date - make a new one (executor-secrets.sh export) and keep the old block and
 * kek.old-<stamp> as long as database backups made before the rotation exist (they open only
 * with the old kek).
 */
import { readKek, checkKek, rotateKek } from '../src/rotation.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return v;
};
const flag = (name: string): boolean => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

try {
  const dir = opt('--dir') ?? (process.env.EXECUTOR_DATA_DIR?.trim() || '/var/lib/valuescan/executor');
  const network = opt('--network') ?? (process.env.SODEX_NETWORK === 'testnet' ? 'testnet' : 'mainnet');
  if (network !== 'mainnet' && network !== 'testnet') throw new Error('--network is mainnet or testnet');
  const kekFile = opt('--kek');
  const kekFrom = opt('--kek-from');
  const noSnapshot = flag('--no-snapshot');
  const [cmd, ...rest] = args;
  if (rest.length) throw new Error(`unknown argument ${rest[0]}`);

  if (cmd === 'check') {
    const r = checkKek({ dir, network, kekFile });
    if (r.failed.length) {
      process.stderr.write(`rotate-kek: ${r.failed.length} of ${r.rows} sealed keys do NOT open under kek ${r.kekId} (${network}): ${r.failed.map((f) => `${f.owner}/${f.slot}`).join(', ')}\n`);
      process.exit(1);
    }
    process.stdout.write(`ok: all ${r.rows} sealed keys open under kek ${r.kekId} (${network})\n`);
  } else if (cmd === 'rotate') {
    const r = rotateKek({ dir, network, newKek: kekFrom ? readKek(kekFrom) : undefined, snapshot: !noSnapshot });
    process.stdout.write(
      [
        r.resumed ? `ok: an unfinished rotation was finished - ${r.rows} sealed keys open under kek ${r.newId}` : `ok: ${r.rows} sealed keys sealed again: kek ${r.oldId} -> ${r.newId} (${network})`,
        `the old kek is kept as ${r.oldFile} (0600) - delete it only when no database backup from before today is left`,
        r.snapshot ? `the database as it was: ${r.snapshot}` : '',
        'NOW: make a new offline kek block - sudo bash /opt/valuescan/bin/executor-secrets.sh export - the old block holds the old kek',
        '',
      ]
        .filter((l, i, a) => l || i === a.length - 1)
        .join('\n'),
    );
  } else {
    process.stderr.write('usage: rotate-kek.ts check [--kek <file>] | rotate [--kek-from <file>] [--dir <d>] [--network mainnet|testnet] [--no-snapshot]\n');
    process.exit(2);
  }
} catch (e) {
  process.stderr.write(`rotate-kek: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
