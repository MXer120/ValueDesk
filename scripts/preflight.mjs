/**
 * Free the dev ports before starting, and say something useful if we cannot.
 *
 * Without this, a leftover backend holds :8787, the new one dies with
 * EADDRINUSE, and the browser silently keeps talking to the OLD build — which
 * looks like a feature being broken rather than a server that never started.
 * That exact confusion cost real debugging time, so the failure is now handled
 * up front instead of being left to read in a stack trace.
 *
 * A listener is only killed when it identifies itself as a Valuetrade backend
 * (via /api/health) or as a Vite dev server we own. Anything else is reported
 * and left alone — silently killing a stranger's process would be worse than
 * the problem being solved.
 */
import { execSync } from 'node:child_process';
import { createConnection } from 'node:net';

const PORTS = [
  { port: Number(process.env.PORT ?? 8797), what: 'Valuetrade backend' },
  { port: 5180, what: 'Vite dev server' },
];

const inUse = (port) =>
  new Promise((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(700);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });

/** Ask the listener whether it is our backend. */
async function isOurBackend(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = await res.json();
    return body?.ok === true && typeof body?.network === 'string';
  } catch {
    return false;
  }
}

function pidsOnPort(port) {
  try {
    const cmd =
      process.platform === 'win32'
        ? `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`
        : `lsof -ti tcp:${port} -s TCP:LISTEN`;
    return [
      ...new Set(
        execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

function kill(pid) {
  try {
    execSync(
      process.platform === 'win32'
        ? `powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force"`
        : `kill -9 ${pid}`,
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

let blocked = false;

for (const { port, what } of PORTS) {
  if (!(await inUse(port))) continue;

  const ours = port === 5180 || (await isOurBackend(port));
  const pids = pidsOnPort(port);

  if (!ours) {
    console.error(
      `\n  Port ${port} is in use by something that is not the ${what}` +
        (pids.length ? ` (pid ${pids.join(', ')})` : '') +
        `.\n  Stop it, or set PORT to something else, then run again.\n`,
    );
    blocked = true;
    continue;
  }

  if (!pids.length) {
    console.error(`\n  Port ${port} is held by a stale ${what} but its pid could not be read.\n`);
    blocked = true;
    continue;
  }

  for (const pid of pids) {
    console.log(`  freeing port ${port} — stopping stale ${what} (pid ${pid})`);
    if (!kill(pid)) {
      console.error(`  could not stop pid ${pid}; stop it manually and retry`);
      blocked = true;
    }
  }
}

if (blocked) process.exit(1);

// Give the OS a moment to release the sockets before the servers bind.
await new Promise((r) => setTimeout(r, 600));
