/**
 * Crashes of ValueDesk's own executor, for the restart scenarios on the hosted target (owner,
 * 2026-10-31: "restarts & crashes" on the ValueDesk executor too - not in production yet).
 *
 * OFF unless LIVE_HOSTED_CRASH=1. Then a restart scenario's kill is a real crash on server 2:
 *   1. a maintenance window for the executor on both servers (maint.sh on: they watch each other),
 *      so neither health check sends a FAILURE and the executor's own "started after a crash"
 *      stays in its log (alerts.ts maintenanceFor);
 *   2. SIGKILL to the executor's process (systemctl kill): no shutdown code runs;
 *   3. systemd starts it again by itself (Restart=always, RestartSec=5), as after any crash;
 * and the scenario's start waits for a new process id, active, and its /health ok, then closes
 * the windows. A window ends by itself after WINDOW_MIN, so a run that died silences nothing for good.
 *
 * Over SSH as ship.sh does (deploy/release/ship.sh: VS_SERVER1, VS_SERVER2, VS_SSH_KEY, the same
 * defaults); every command is one fixed line, nothing from the run goes into it.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UNIT = 'valuescan-executor.service';
const WINDOW_MIN = 15;
const WHAT = 'live test: executor crash and restart';

export function hostedCrashOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LIVE_HOSTED_CRASH === '1';
}

export class HostedOps {
  private readonly s1: string;
  private readonly s2: string;
  private readonly key: string;
  /** The process killed last (its MainPID), until a new one is up. */
  private killedPid: number | null = null;
  private windows = false;

  constructor(env: NodeJS.ProcessEnv = process.env, private readonly log: (s: string) => void = () => {}) {
    this.s1 = env.VS_SERVER1 || 'almalinux@161.97.154.121';
    this.s2 = env.VS_SERVER2 || 'almalinux@13.140.77.201';
    this.key = env.VS_SSH_KEY || join(homedir(), '.ssh', 'valuescan-contabo');
  }

  private run(host: string, command: string, timeoutMs = 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = spawn('ssh', ['-i', this.key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR', host, command], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const timer = setTimeout(() => p.kill(), timeoutMs);
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim());
        else reject(new Error(`ssh ${host} "${command}" exited ${code}: ${(err || out).trim().slice(0, 300)}`));
      });
    });
  }

  /** MainPID and ActiveState of the executor's unit. */
  async unit(): Promise<{ pid: number; state: string }> {
    const out = await this.run(this.s2, `systemctl show -p MainPID -p ActiveState ${UNIT}`);
    const pid = Number(/MainPID=(\d+)/.exec(out)?.[1] ?? 0);
    const state = /ActiveState=(\S+)/.exec(out)?.[1] ?? 'unknown';
    return { pid, state };
  }

  /** The window, then SIGKILL; returns the killed process id. */
  async crash(): Promise<number> {
    if (!this.windows) {
      for (const h of [this.s1, this.s2]) await this.run(h, `sudo bash /opt/valuescan/bin/maint.sh on ${WINDOW_MIN} '${WHAT}' executor`);
      this.windows = true;
    }
    const before = await this.unit();
    if (!(before.pid > 0) || before.state !== 'active') throw new Error(`ValueDesk's executor is not running (${before.state}, pid ${before.pid}): nothing to crash`);
    await this.run(this.s2, `sudo systemctl kill -s SIGKILL ${UNIT}`);
    this.killedPid = before.pid;
    this.log(`  SIGKILL to ValueDesk's executor (pid ${before.pid}); systemd starts it again by itself`);
    return before.pid;
  }

  /** After a crash: a new process, active, and `healthy()` true; then the windows close. */
  async waitUp(healthy: () => Promise<boolean>, timeoutMs = 120_000): Promise<{ pid: number; ms: number }> {
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < timeoutMs) {
      try {
        const u = await this.unit();
        last = `${u.state}, pid ${u.pid}`;
        if (u.state === 'active' && u.pid > 0 && u.pid !== this.killedPid && (await healthy())) {
          this.log(`  ValueDesk's executor is up again as pid ${u.pid} after ${Math.round((Date.now() - t0) / 1000)} s`);
          this.killedPid = null;
          await this.close();
          return { pid: u.pid, ms: Date.now() - t0 };
        }
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`ValueDesk's executor was not up again within ${timeoutMs / 1000} s after the crash (${last})`);
  }

  /** Close the windows this opened (each also ends by itself). */
  async close(): Promise<void> {
    if (!this.windows) return;
    this.windows = false;
    for (const h of [this.s1, this.s2]) {
      await this.run(h, 'sudo bash /opt/valuescan/bin/maint.sh off').catch((e) => this.log(`  ! the maintenance window on ${h} is still open (it ends by itself within ${WINDOW_MIN} min): ${String(e)}`));
    }
  }
}
