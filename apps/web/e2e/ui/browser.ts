/**
 * The browser and the dev web the UI specs run against.
 *
 * EDGE, THE ONE ALREADY INSTALLED. playwright-core ships no browser and this
 * module never downloads one (the laptop's bandwidth cap): it launches
 * `channel: 'msedge'`, and where Edge sits in the newer EdgeCore layout
 * (`Program Files (x86)\Microsoft\EdgeCore\<version>\msedge.exe`, no
 * `Edge\Application\msedge.exe`) that channel is not found, so the newest
 * EdgeCore build is launched by path instead. `VS_E2E_EDGE` names an
 * executable explicitly.
 *
 * THE DEV WEB. `VS_E2E_WEB` (or `--web`) names it; otherwise the first of
 * 127.0.0.1:5180..5183 that answers with ValueDesk's index.html served by Vite
 * (`/@vite/client` in it: a dev server, so `window.__vsTest` is there).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type LaunchOptions } from 'playwright-core';

export const DEV_PORTS = [5180, 5181, 5182, 5183] as const;

/** Newest first: "156.0.4314.50" before "155.0.4283.62". */
const byVersionDesc = (a: string, b: string): number => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/** Every msedge.exe this machine has, the preferred one first. Windows only; elsewhere the channel decides. */
export function edgeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.VS_E2E_EDGE?.trim()) out.push(env.VS_E2E_EDGE.trim());
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter((r): r is string => !!r);
  for (const root of roots) out.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const root of roots) {
    const core = join(root, 'Microsoft', 'EdgeCore');
    if (!existsSync(core)) continue;
    const versions = readdirSync(core).filter((d) => /^\d+(\.\d+)+$/.test(d)).sort(byVersionDesc);
    for (const v of versions) out.push(join(core, v, 'msedge.exe'));
  }
  return [...new Set(out)].filter((p) => existsSync(p));
}

export interface LaunchEdgeOptions {
  headed?: boolean;
  slowMo?: number;
}

/** Microsoft Edge, as installed. Throws (with what was tried) when there is none - never downloads. */
export async function launchEdge(o: LaunchEdgeOptions = {}): Promise<Browser> {
  const base: LaunchOptions = {
    headless: !o.headed,
    slowMo: o.slowMo,
    // A test profile: no first-run pages, no sync, no Edge sidebar.
    args: ['--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeSidebarV2,msUndersideButton'],
  };
  const explicit = process.env.VS_E2E_EDGE?.trim();
  if (!explicit) {
    try {
      return await chromium.launch({ ...base, channel: 'msedge' });
    } catch (e) {
      if (!/not found|doesn't exist|is not installed|no such file/i.test(String((e as Error)?.message ?? e))) throw e;
    }
  }
  const tried: string[] = [];
  for (const executablePath of edgeCandidates()) {
    tried.push(executablePath);
    try {
      return await chromium.launch({ ...base, executablePath });
    } catch (e) {
      if (executablePath === explicit) throw e;
    }
  }
  throw new Error(
    `Microsoft Edge was not found (channel msedge${tried.length ? `, then ${tried.join(', ')}` : ''}). ` +
      'Install Edge or set VS_E2E_EDGE to msedge.exe - this runner never downloads a browser.',
  );
}

/** Whether `origin` serves ValueDesk from a Vite dev server. */
export async function isDevWeb(origin: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const r = await fetch(`${origin}/`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const html = await r.text();
    return /<title>ValueDesk<\/title>/.test(html) && html.includes('/@vite/client');
  } catch {
    return false;
  }
}

/** The dev web to test: `VS_E2E_WEB`, else the first local Vite port serving ValueDesk. */
export async function findDevWeb(explicit = process.env.VS_E2E_WEB?.trim()): Promise<string> {
  if (explicit) {
    const origin = explicit.replace(/\/+$/, '');
    if (!(await isDevWeb(origin))) throw new Error(`${origin} does not serve the ValueDesk dev web (no Vite index.html there).`);
    return origin;
  }
  for (const port of DEV_PORTS) {
    const origin = `http://127.0.0.1:${port}`;
    if (await isDevWeb(origin)) return origin;
  }
  throw new Error(
    `No ValueDesk dev web on 127.0.0.1:${DEV_PORTS.join('/')}. Start it (.claude/launch.json "valuescan-web", or npm run dev in apps/web) or set VS_E2E_WEB.`,
  );
}
