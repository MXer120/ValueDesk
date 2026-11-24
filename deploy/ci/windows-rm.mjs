// Loaded before every test file on Windows (run-tests.mjs): a test's clean-up of its own temporary folder is tried again
// for two seconds. Windows refuses to delete a file that a thread just ended, or the virus scanner, still holds; Linux
// does not. Only recursive deletions under the temporary directory, and only the refusals of that kind.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

const rm = fs.rmSync;
const TMP = resolve(tmpdir()).toLowerCase() + sep;
fs.rmSync = (path, opts) => {
  const mine = opts?.recursive && typeof path === 'string' && resolve(path).toLowerCase().startsWith(TMP);
  for (let i = 0; ; i++) {
    try { return rm(path, opts); } catch (e) {
      if (!mine || i >= 20 || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(e?.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
};
syncBuiltinESMExports();
