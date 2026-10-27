/**
 * Replace the executor's session.key or import.key, with an audit row (src/rotation.ts).
 *
 *   ... rotate-key.ts session    EXECUTOR STOPPED: a new session.key - every follower's dashboard
 *                                token ends; they sign once more (copies and algos keep running)
 *   ... rotate-key.ts import     EXECUTOR STOPPED: a new import.key (P-256) - a key import that is
 *                                under way at that moment fails once and is sent again
 *
 * The old file stays as <name>.old-<stamp> (0600) for a rollback; delete it afterwards.
 * Options: --dir <d> (default $EXECUTOR_DATA_DIR, else /var/lib/valuescan/executor).
 * deploy/server/bin/rotate-secret.sh executor-session | executor-import runs this with the stop,
 * the start and the health check around it.
 */
import { rotateKeyFile } from '../src/rotation.ts';

const args = process.argv.slice(2);
try {
  let dir = process.env.EXECUTOR_DATA_DIR?.trim() || '/var/lib/valuescan/executor';
  const i = args.indexOf('--dir');
  if (i >= 0) {
    const v = args[i + 1];
    if (!v) throw new Error('--dir needs a value');
    dir = v;
    args.splice(i, 2);
  }
  const [which, ...rest] = args;
  if ((which !== 'session' && which !== 'import') || rest.length) {
    process.stderr.write('usage: rotate-key.ts session|import [--dir <d>]\n');
    process.exit(2);
  }
  const r = rotateKeyFile({ dir, which });
  process.stdout.write(`ok: ${r.file} replaced (${r.oldId ?? 'none'} -> ${r.newId})${r.oldFile ? `; the old one is ${r.oldFile} - delete it once the executor runs well` : ''}\n`);
} catch (e) {
  process.stderr.write(`rotate-key: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
