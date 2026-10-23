// Run an npm command with THIS Node on PATH - for a launcher (an IDE, a
// preview runner) that starts node.exe by full path on a machine where Node
// is not on PATH, so `npm run dev` and the tsx it starts can find `node`.
//
//   node scripts/with-node.mjs --prefix apps/web run dev
import { spawn } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';

const dir = dirname(process.execPath);
const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}` };
if (process.platform === 'win32') env.Path = env.PATH;
// npm's own CLI under this node (no shell, so the arguments are passed as they are).
const npmCli = process.platform === 'win32' ? join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js') : join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const child = spawn(process.execPath, [npmCli, ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
