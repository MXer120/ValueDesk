/**
 * valuescan-indexer.service's main process: it runs the indexer as a child, and on `systemctl reload` (SIGHUP) starts the
 * next one beside it to take over (handover.ts) - from the release `current` points to then.
 *
 *   ExecStart=node --import tsx src/indexer/supervisor.ts <the child's node arguments and script>
 *   ExecReload=/bin/kill -HUP $MAINPID
 *
 * Why a supervisor and not two units (valuescan-indexer@a/@b): every script, alert and habit names
 * valuescan-indexer.service (release.sh, healthcheck, maint windows, `journalctl -u`, `systemctl kill -s SIGUSR2`), and
 * one unit keeps one cgroup, so MemoryMax still bounds both processes together while they overlap.
 *
 * What it does, and nothing more (it is the one part a handover cannot replace):
 *   - SIGHUP: start a standby child (VALUESCAN_INDEXER_STANDBY=1) from `current`; track its phases (IPC); once it took
 *     over, it is the active child and this process moves its working directory to the child's release (release.sh
 *     reads which release the unit runs from it). A reload while one is under way is ignored.
 *   - the active child ends on its own (a crash): the standby, if any, is stopped and this process exits with the child's
 *     code - systemd restarts the unit 30 s later, as before.
 *   - a standby that gives up (exit 75): logged and written to the state file; the active child carries on. One that
 *     ends after the active child took its request: nobody writes, so this process exits 1 (systemd restarts it).
 *   - SIGTERM / SIGINT: every child stopped (systemd sends them SIGTERM too: control-group), this process ends after them.
 *   - SIGUSR2: passed to the active child (cpuProfile.ts: a CPU profile).
 *
 * The state file (VS_INDEXER_STATE, default /var/lib/valuescan/state/indexer-handover.json) says where the last handover
 * stands: release.sh waits on it and falls back to a classic restart when it says `failed` or nothing changes in time.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const childArgs = process.argv.slice(2);
const DIR = process.env.VS_INDEXER_DIR?.trim() || process.cwd();
const STATE = process.env.VS_INDEXER_STATE?.trim() || '/var/lib/valuescan/state/indexer-handover.json';
const log = (line: string) => console.log(`[supervisor] ${line}`);

interface State {
  seq: number;
  phase: 'running' | 'standby' | 'requested' | 'accepted' | 'promoted' | 'failed';
  at: number;
  activePid: number | null;
  activeRelease: string | null;
  standbyPid?: number | null;
  standbyRelease?: string | null;
  reason?: string;
  /** Milliseconds: the standby's start to its request, the request to its takeover, the lock wait. */
  timings?: Record<string, number>;
}

const releaseOf = (dir: string): string | null => /\/releases\/([^/]+)\//.exec(`${dir.replace(/\\/g, '/')}/`)?.[1] ?? null;

let state: State = (() => {
  try {
    const j = JSON.parse(readFileSync(STATE, 'utf8')) as Partial<State>;
    return { seq: Number(j.seq) || 0, phase: 'running', at: Date.now(), activePid: null, activeRelease: null };
  } catch {
    return { seq: 0, phase: 'running', at: Date.now(), activePid: null, activeRelease: null };
  }
})();
const save = (patch: Partial<State>) => {
  state = { ...state, ...patch, at: Date.now() };
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(`${STATE}.tmp`, JSON.stringify(state));
    renameSync(`${STATE}.tmp`, STATE);
  } catch (e) {
    log(`state file not written: ${String(e)}`);
  }
};

interface Kid { proc: ChildProcess; dir: string; release: string | null; standby: boolean; phases: Map<string, number>; tookRequest: boolean }

let active: Kid | null = null;
let incoming: Kid | null = null;
let stopping = false;
/** The active child took the standby's request: from then on only the standby can write. */
let handingOver = false;

function start(standby: boolean): Kid {
  const dir = realpathSync(DIR);
  const env = { ...process.env };
  if (standby) env.VALUESCAN_INDEXER_STANDBY = '1';
  else delete env.VALUESCAN_INDEXER_STANDBY;
  const proc = spawn(process.execPath, childArgs, { cwd: dir, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const kid: Kid = { proc, dir, release: releaseOf(dir), standby, phases: new Map(), tookRequest: false };
  proc.on('message', (m) => onMessage(kid, m as { handover?: string; reason?: string } & Record<string, unknown>));
  proc.on('exit', (code, signal) => onExit(kid, code, signal));
  log(`started ${standby ? 'a standby' : 'the indexer'} (pid ${proc.pid}, release ${kid.release ?? dir})`);
  return kid;
}

function onMessage(kid: Kid, m: { handover?: string; reason?: string } & Record<string, unknown>): void {
  if (!m?.handover) return;
  kid.phases.set(m.handover, Date.now());
  if (kid === active) {
    if (m.handover === 'accepted') { kid.tookRequest = true; handingOver = true; }
    return;
  }
  if (kid !== incoming) return;
  if (m.handover === 'standby' || m.handover === 'requested' || m.handover === 'accepted') {
    save({ phase: m.handover as State['phase'] });
  } else if (m.handover === 'promoted') {
    const started = kid.phases.get('standby') ?? state.at;
    const asked = kid.phases.get('requested');
    active = kid;
    incoming = null;
    handingOver = false;
    try { process.chdir(kid.dir); } catch (e) { log(`working directory not moved to ${kid.dir}: ${String(e)}`); }
    save({
      phase: 'promoted', activePid: kid.proc.pid ?? null, activeRelease: kid.release, standbyPid: null,
      timings: { standbyToRequestMs: asked ? asked - started : -1, requestToTakeoverMs: asked ? Date.now() - asked : -1, lockWaitMs: Number(m.lockWaitMs) || 0, buffered: Number(m.buffered) || 0 },
    });
    log(`handover done: pid ${kid.proc.pid} (release ${kid.release}) writes the index`);
  } else if (m.handover === 'failed') {
    save({ phase: 'failed', reason: String(m.reason ?? 'the standby gave up') });
  }
}

function onExit(kid: Kid, code: number | null, signal: NodeJS.Signals | null): void {
  const how = signal ? `signal ${signal}` : `code ${code}`;
  if (stopping) {
    if (kid === incoming) incoming = null;
    if (kid === active) active = null;
    if (!active && !incoming) process.exit(0);
    return;
  }
  if (kid === incoming) {
    incoming = null;
    const took = handingOver;
    if (state.phase !== 'failed') save({ phase: 'failed', reason: `the standby ended (${how}) before it took over` });
    log(`the standby (pid ${kid.proc.pid}) ended with ${how} before taking over${took ? '; the indexer had already taken its request and is stopping: nobody will write, exiting for systemd to restart the unit' : '; the running indexer carries on'}`);
    if (took) process.exit(1);
    return;
  }
  if (kid !== active) {
    // The standby took over before this end was seen (a busy machine): said all the same.
    if (kid.tookRequest) log(`the indexer (pid ${kid.proc.pid}) handed over and ended (${how})`);
    return;
  }
  if (kid === active) {
    active = null;
    if (kid.tookRequest && incoming) {
      // Handed over: the standby takes the lock now (its 'promoted' follows).
      log(`the indexer (pid ${kid.proc.pid}) handed over and ended (${how})`);
      return;
    }
    log(`the indexer (pid ${kid.proc.pid}) ended on its own (${how})${incoming ? '; stopping the standby' : ''}; exiting for systemd to restart the unit`);
    if (incoming) { if (process.platform === 'win32') incoming.proc.send('stop'); else incoming.proc.kill('SIGTERM'); }
    process.exit(code && code > 0 ? code : 1);
  }
}

const reload = () => {
  if (stopping) return;
  if (incoming) { log(`reload ignored: a handover is under way (standby pid ${incoming.proc.pid})`); return; }
  if (!active) { log('reload ignored: no indexer running'); return; }
  incoming = start(true);
  save({ seq: state.seq + 1, phase: 'standby', standbyPid: incoming.proc.pid ?? null, standbyRelease: incoming.release, reason: undefined, timings: undefined });
};
process.on('SIGHUP', reload);
// The tests' reload (handover.test.ts): Windows has no SIGHUP. systemd starts this process with no IPC channel.
process.on('message', (m) => { if (m === 'reload') reload(); else if (m === 'stop') process.emit('SIGTERM'); });
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping the indexer${incoming ? ' and the standby' : ''}`);
    // Windows (the tests) has no SIGTERM to hand a child: it is told over IPC (main.ts takes 'stop' as SIGTERM).
    for (const k of [incoming, active]) if (k) { if (process.platform === 'win32') k.proc.send('stop'); else k.proc.kill('SIGTERM'); }
    if (!active && !incoming) process.exit(0);
  });
}
process.on('SIGUSR2', () => { active?.proc.kill('SIGUSR2'); });

active = start(false);
save({ phase: 'running', activePid: active.proc.pid ?? null, activeRelease: active.release });
