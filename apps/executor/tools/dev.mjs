// Local development: the executor in HOSTED mode on 127.0.0.1:8799, behind the
// web dev server's /api/copy proxy (apps/web/vite.config.ts) - the way the
// site reaches it in production. Its data (and the keys it generates) go to
// the user's local app data, never into the (cloud-synced) repository.
//
//   node tools/dev.mjs            (from apps/executor)
import { spawn } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const base = platform() === 'win32' ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local') : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
const env = {
  EXECUTOR_KIND: 'hosted',
  EXECUTOR_EDGE: 'none',
  EXECUTOR_DATA_DIR: join(base, platform() === 'win32' ? 'Valuescan' : 'valuescan', 'executor-dev'),
  EXECUTOR_LOCATION: 'this computer (dev)',
  PORT: '8799',
  ...process.env,
};
// tsx's own CLI under THIS node: works where node is not on PATH.
const tsx = join(here, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawn(process.execPath, [tsx, 'watch', '--disable-warning=ExperimentalWarning', join(here, '..', 'src', 'main.ts')], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
