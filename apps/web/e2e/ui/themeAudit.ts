/**
 * The light theme, element by element and state by state (owner, 2026-11-05: "every state of every
 * element needs to be verified"). Not a spec: a tool that writes a report.
 *
 *   npx tsx e2e/ui/themeAudit.ts [--theme light] [--viewport desktop|phone] [--only word,word] [--shots <dir>] [--out <file.json>]
 *
 * Needs the dev web and API (.claude/launch.json). Nothing reaches SoDEX's write routes (sodexFake.ts).
 *
 * THREE PASSES, IN EVERY SCENE (a scene is a page, a tab, an open menu or dialog, a seeded account):
 *   1. resting: every visible element with text or an icon, against what is really behind it (its
 *      own and its ancestors' fills composited, the worst stop of a gradient, opacity included).
 *   2. forced states: every kind of interactive element, with :hover, :focus-visible and :active forced
 *      through the browser's own devtools protocol, measured again with what is inside it.
 *   3. the sheets: once, every CSS rule the app loaded, states no scene reaches included, resolved
 *      under the theme: a light text colour or a dark fill is listed unless theme-light.css answers it.
 *
 * Measured: 4.5:1 for text, 3:1 for large text and icons, 2:1 for disabled. Dark fills of a real size
 * are listed by themselves. What a canvas draws is not in the DOM: `--shots` saves each scene for the eye.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CDPSession, Page } from 'playwright-core';
import { findDevWeb, launchEdge } from './browser';
import { acceptWelcome, newUiContext } from './harness';
import { ticket } from './ticket';
import { enableTrading, sideButton } from './trade';
import { createTestWallet } from './wallet';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const THEME = arg('theme', 'light')!;
const PHONE = arg('viewport', 'desktop') === 'phone';
const ONLY = arg('only')?.split(',');
const SHOTS = arg('shots');
/** --lang de: note, page by page, every piece of English that language's catalogue lacks, to <out>.missing.json. The page stays English. */
const LANG = arg('lang');
const MISSING = new Map<string, string>();
const OUT = arg('out', join(dirname(fileURLToPath(import.meta.url)), '.out', `theme-audit-${THEME}-${PHONE ? 'phone' : 'desktop'}.json`))!;
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

export interface Finding {
  kind: 'contrast' | 'icon' | 'dark-fill';
  scene: string;
  state: string;
  who: string;
  text: string;
  fg: string;
  bg: string;
  ratio: number;
  need: number;
}

/* ------------------------------------------------------------------ in the page ----- */

const PAGE_LIB = `
(() => {
  const parse = (c) => {
    if (!c || c === 'transparent') return [0, 0, 0, 0];
    const m = /rgba?\\(([^)]+)\\)/.exec(c);
    if (m) {
      const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    const s = /color\\(srgb ([^)]+)\\)/.exec(c);
    if (s) {
      const p = s[1].split(/[ \\/]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
    }
    return null;
  };
  const over = (top, under) => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (a <= 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a);
  };
  const lum = (c) => {
    const f = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') + (c[3] < 0.995 ? '@' + c[3].toFixed(2) : '');
  const stops = (img) => {
    if (!img || img === 'none' || !/gradient/.test(img)) return [];
    return (img.match(/rgba?\\([^)]+\\)|color\\(srgb [^)]+\\)/g) || []).map(parse).filter(Boolean);
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const who = (el) => {
    const c = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.') : '';
    let p = el.parentElement, up = '';
    if (!c) { while (p && !up) { up = typeof p.className === 'string' ? p.className.trim().split(/\\s+/)[0] || '' : ''; p = p.parentElement; } }
    return el.tagName.toLowerCase() + (c ? '.' + c : up ? ' in .' + up : '');
  };
  /* What an element paints behind its own content: its fill and gradient, and a ::before layer that covers it (the panels' glass). */
  const layersOf = (e) => {
    const s = getComputedStyle(e);
    const out = [];
    const b = getComputedStyle(e, '::before');
    if (b.content !== 'none' && b.position === 'absolute' && (parseInt(b.top) <= 1 || b.inset.startsWith('-')) && parseInt(b.zIndex) < 0) {
      out.push({ f: parse(b.backgroundColor) || [0, 0, 0, 0], g: stops(b.backgroundImage) });
    }
    out.unshift({ f: parse(s.backgroundColor) || [0, 0, 0, 0], g: stops(s.backgroundImage) });
    return { layers: out, opacity: Number(s.opacity) };
  };
  const page = () => { const d = document.createElement('i'); d.style.color = 'var(--bg)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return parse(c); };
  /* Paints upward from the element, as the browser does: an ancestor's opacity fades its whole group, text and fill together. */
  const paint = (el, base, fg, pick) => {
    let front = fg;
    let back = [0, 0, 0, 0];
    for (let e = el; e; e = e.parentElement) {
      const { layers, opacity } = layersOf(e);
      for (const l of layers) {
        if (l.g.length) { const g = pick(l.g); back = over(back, g); front = over(front, g); }
        back = over(back, l.f);
        front = over(front, l.f);
      }
      if (opacity < 1) { back = [back[0], back[1], back[2], back[3] * opacity]; front = [front[0], front[1], front[2], front[3] * opacity]; }
    }
    back = over(back, base);
    front = over(front, base);
    return { front, back, r: ratio(front, back) };
  };
  const behind = (el, base, fg) => {
    const a = paint(el, base, fg, (g) => g[g.length - 1]);
    const b = paint(el, base, fg, (g) => g[0]);
    return a.r < b.r ? a : b;
  };
  const opacityOf = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const ownText = (el) => {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value || el.placeholder || '';
    if (el.tagName === 'SELECT') return el.selectedOptions[0]?.textContent || '';
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.trim();
  };
  const SKIP = 'input[type=checkbox], input[type=radio], input[type=range], input[type=color], canvas, video, iframe, script, style, noscript, .sr-only, [aria-hidden="true"] .sr-only';
  const isDisabled = (el) => !!el.closest('[disabled], [aria-disabled="true"], .is-off, .is-disabled, .disabled, fieldset[disabled]');
  window.__audit = (root, scene, state) => {
    const base = page();
    const out = [];
    const list = root === document.body ? root.querySelectorAll('*') : [root, ...root.querySelectorAll('*')];
    for (const el of list) {
      if (el.matches(SKIP) || !shown(el)) continue;
      const s = getComputedStyle(el);
      const op = opacityOf(el);
      if (op < 0.02) continue;
      const text = ownText(el);
      const isIcon = el.tagName === 'svg' && !el.closest('svg svg') && (s.fill === 'none' || /currentcolor/i.test(el.getAttribute('stroke') || el.getAttribute('fill') || ''));
      if (text || isIcon) {
        const raw = parse(s.color);
        if (raw && raw[3] > 0) {
          const fg = raw;
          const size = parseFloat(s.fontSize);
          const large = size >= 24 || (size >= 18.6 && Number(s.fontWeight) >= 600);
          const need = isDisabled(el) ? 2 : isIcon || large ? 3 : 4.5;
          const { front, back, r } = behind(el, base, fg);
          if (r < need) out.push({ kind: isIcon ? 'icon' : 'contrast', scene, state, who: who(el), text: (text || '').slice(0, 40), fg: hex(front), bg: hex(back), ratio: Math.round(r * 100) / 100, need });
        }
      }
      const fill = parse(s.backgroundColor);
      const box = el.getBoundingClientRect();
      if (fill && fill[3] >= 0.5 && box.width * box.height >= 300 && lum(fill) < 0.14 && !el.matches('img, picture')) {
        out.push({ kind: 'dark-fill', scene, state, who: who(el), text: (el.textContent || '').trim().slice(0, 30), fg: hex(parse(s.color) || [0, 0, 0, 1]), bg: hex(fill), ratio: 0, need: 0 });
      }
    }
    return out;
  };
  /* Pass 3: every rule of every sheet, under this theme. */
  window.__sheets = () => {
    const probe = document.createElement('i');
    probe.style.display = 'none';
    document.body.append(probe);
    const resolve = (prop, v) => {
      probe.style.removeProperty(prop);
      probe.style.setProperty(prop, v);
      return getComputedStyle(probe).getPropertyValue(prop);
    };
    const out = [];
    let rules = 0, unresolved = 0;
    const walk = (list) => {
      for (const r of list) {
        if (r.cssRules && !r.style) { walk(r.cssRules); continue; }
        if (r.cssRules && r.cssRules.length) walk(r.cssRules);
        if (!r.style) continue;
        rules++;
        for (const [prop, test] of [['color', (c) => lum(c) > 0.62], ['background-color', (c) => c[3] >= 0.5 && lum(c) < 0.14], ['fill', (c) => lum(c) > 0.62], ['stroke', (c) => lum(c) > 0.62]]) {
          const v = r.style.getPropertyValue(prop);
          if (!v || /^(inherit|initial|currentcolor|none|transparent|unset)$/i.test(v)) continue;
          if (/var\\(--(?!ink|bg|text|muted|dim|line|panel|pos|neg|warn|accent|disabled|tint|mix)/.test(v)) { unresolved++; continue; }
          const c = parse(resolve(prop, v));
          if (c && test(c)) out.push({ selector: r.selectorText, prop, value: v, resolved: hex(c) });
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules); } catch { /* another origin's sheet */ }
    }
    probe.remove();
    return { rules, unresolved, flagged: out };
  };
})();
`;

/* ------------------------------------------------------------------ in Node ----- */

const findings: Finding[] = [];
const covered: Array<{ scene: string; ok: boolean; note?: string; elements?: number; states?: number }> = [];
let cdp: CDPSession;

const INTERACTIVE = 'button,a[href],[role=button],[role=tab],[role=menuitem],[role=menuitemradio],[role=option],[role=switch],[role=radio],[role=checkbox],input,select,textarea,label,summary,tr,li,[tabindex]';

/** Kind of an element: forced states are measured on the first few of each kind in a scene. */
const KIND_FN = `function () {
  const r = this.getBoundingClientRect();
  if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.left > innerWidth || r.right < 0) return '';
  return this.tagName + '|' + (typeof this.className === 'string' ? this.className : '') + '|' + (this.getAttribute('role') || '') + '|' + (this.getAttribute('aria-selected') || '') + (this.getAttribute('aria-checked') || '') + (this.disabled ? 'd' : '');
}`;

async function forcedStates(scene: string): Promise<{ elements: number; states: number }> {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: INTERACTIVE });
  const perKind = new Map<string, number>();
  let elements = 0;
  let states = 0;
  for (const nodeId of nodeIds) {
    let objectId: string | undefined;
    try {
      ({ object: { objectId } } = await cdp.send('DOM.resolveNode', { nodeId }));
      if (!objectId) continue;
      const kind = (await cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: KIND_FN, returnByValue: true })).result.value as string;
      if (!kind) continue;
      const seen = perKind.get(kind) ?? 0;
      if (seen >= 2) continue;
      perKind.set(kind, seen + 1);
      elements++;
      for (const state of [['hover'], ['focus', 'focus-visible'], ['active']]) {
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: state });
        const r = await cdp.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function (scene, state) { return window.__audit(this, scene, state); }`,
          arguments: [{ value: scene }, { value: `:${state.at(-1)}` }],
          returnByValue: true,
        });
        findings.push(...((r.result.value ?? []) as Finding[]));
        states++;
      }
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    } catch {
      /* the node went away mid-way (a live table re-rendered) */
    }
  }
  return { elements, states };
}

async function audit(page: Page, scene: string): Promise<void> {
  await page.waitForTimeout(400);
  await ready(page); // a chunk's reload or a navigation may have dropped them
  const resting = (await page.evaluate(([s]) => (window as unknown as { __audit: (r: Element, s: string, t: string) => Finding[] }).__audit(document.body, s!, 'resting'), [scene])) as Finding[];
  findings.push(...resting);
  const { elements, states } = await forcedStates(scene);
  covered.push({ scene, ok: true, elements, states });
  if (LANG) for (const m of await page.evaluate(() => [...((window as unknown as { __vsI18nMissing?: Set<string> }).__vsI18nMissing ?? [])])) if (!MISSING.has(m)) MISSING.set(m, scene);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${scene.replace(/[^a-z0-9]+/gi, '-')}.png`) });
  }
  console.log(`  ${scene}: ${resting.length} at rest, ${elements} interactive kinds, ${states} forced states`);
}

const STILL = '*, *::before, *::after { transition: none !important; animation: none !important; }';
async function ready(page: Page): Promise<void> {
  await page.addStyleTag({ content: STILL });
  await page.evaluate(PAGE_LIB);
  cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await cdp.send('Runtime.enable');
}

type Scene = [string, (page: Page) => Promise<void>];
const esc = (page: Page) => page.keyboard.press('Escape');
const wait = (page: Page, ms = 1500) => page.waitForTimeout(ms);
const tap = async (page: Page, text: string | RegExp, ms = 1200) => { await page.getByText(text).first().click({ timeout: 6000, force: true }); await wait(page, ms); };
const role = async (page: Page, r: 'button' | 'tab' | 'link' | 'menuitem' | 'radio', name: string | RegExp, ms = 1200) => { await page.getByRole(r, { name }).first().click({ timeout: 6000, force: true }); await wait(page, ms); };
const go = async (page: Page, path: string, ms = 4500) => { await page.goto(new URL(path, page.url()).href, { waitUntil: 'domcontentloaded' }); await wait(page, ms); await ready(page); };

const settingsSection = (name: string): Scene => [`settings ${name}`, async (p) => {
  if (!(await p.getByRole('dialog', { name: 'Settings' }).isVisible())) {
    await esc(p);
    await p.waitForTimeout(300);
    await role(p, 'button', /^Settings/);
  }
  await p.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name, exact: true }).first().click({ force: true });
  await wait(p, 600);
}];

/** No wallet: the public pages, their tabs, menus and dialogs. */
const PUBLIC: Scene[] = [
  ['trade', async (p) => go(p, '/trade')],
  ['trade timeframe menu', async (p) => { await p.locator('.kc-toolbar button').filter({ hasText: /^$/ }).first().click({ force: true }).catch(() => {}); await wait(p, 600); }],
  ['trade indicators', async (p) => { await esc(p); await tap(p, 'Indicators'); }],
  ['trade depth view', async (p) => { await esc(p); await tap(p, 'Depth'); }],
  ['trade market info', async (p) => { await tap(p, 'Market info'); }],
  ['trade trade flow', async (p) => { await tap(p, 'Chart'); await role(p, 'button', 'Trade flow', 3000); }],
  ['trade order book settings', async (p) => { await role(p, 'button', 'Trade flow'); await role(p, 'button', 'Display unit and price grouping'); }],
  ['trade trades tape', async (p) => { await esc(p); await tap(p, 'Trades'); }],
  ['ticket limit', async (p) => { await tap(p, 'Order Book'); await ticket(p).g.getByText('Limit', { exact: true }).first().click({ force: true }); await wait(p, 500); }],
  ['ticket market', async (p) => { await ticket(p).g.getByText('Market', { exact: true }).first().click({ force: true }); await wait(p, 500); }],
  ['ticket stop', async (p) => { await ticket(p).g.getByText('Stop', { exact: true }).first().click({ force: true }); await wait(p, 500); }],
  ['ticket short side', async (p) => { await ticket(p).g.getByText('Short', { exact: true }).first().click({ force: true }); await wait(p, 500); }],
  ['ticket leverage popover', async (p) => { await p.locator('.panel.oe .oe-mode__btn').first().click({ force: true }); await wait(p, 700); }],
  ['ticket margin popover', async (p) => { await esc(p); await p.locator('.panel.oe .oe-mode__btn').nth(1).click({ force: true }); await wait(p, 700); }],
  ['ticket algo menu', async (p) => { await esc(p); await ticket(p).g.getByText('Algo', { exact: true }).first().click({ force: true }); await wait(p, 900); }],
  ['ticket tp/sl and reduce only', async (p) => { await esc(p); await ticket(p).g.getByText('Limit', { exact: true }).first().click({ force: true }); for (const box of await p.locator('.oe .oe-switch input').all()) await box.click({ force: true }).catch(() => {}); await wait(p, 600); }],
  ['heatmap live', async (p) => { await go(p, '/trade'); await p.getByText('Liq. heatmap', { exact: true }).first().dispatchEvent('click'); await wait(p, 3000); }],
  ['heatmap view menu', async (p) => { await p.locator('.lqm').getByText('View', { exact: true }).first().click({ force: true }); await wait(p, 700); }],
  ['heatmap platforms', async (p) => { await esc(p); await p.locator('.lqm').getByText(/platforms?$/i).first().click({ force: true }); await wait(p, 700); }],
  ['heatmap chart', async (p) => { await esc(p); await p.locator('.lqm-seg button', { hasText: 'Chart' }).click({ force: true }); await wait(p, 3000); }],
  ['heatmap history', async (p) => { await p.locator('.lqm-seg button', { hasText: 'Historical' }).click({ force: true }); await wait(p, 4000); }],
  ['tab add menu', async (p) => { await role(p, 'button', 'Add a market'); }],
  ['market search', async (p) => { await esc(p); await p.getByRole('button', { name: /^Search markets/ }).first().click({ force: true }); await wait(p, 2500); }],
  ['palette traders', async (p) => { await p.getByRole('tab', { name: /Traders/ }).first().click({ force: true }); await wait(p, 1500); }],
  ['palette screener', async (p) => { await p.getByRole('tab', { name: /Screener/ }).first().click({ force: true }); await wait(p, 2000); }],
  ['palette assets', async (p) => { await p.getByRole('tab', { name: /Assets/ }).first().click({ force: true }); await wait(p, 1500); }],
  ['more menu', async (p) => { await esc(p); await tap(p, 'More', 500); }],
  ['notifications', async (p) => { await esc(p); await p.getByRole('banner').getByRole('button', { name: /^Notifications/ }).click({ force: true }); await wait(p, 800); }],
  ['notifications view', async (p) => { await p.getByRole('dialog', { name: 'Notifications' }).getByRole('button', { name: /View/ }).first().click({ force: true }); await wait(p, 600); }],
  ['privacy and terminal rail', async (p) => { await esc(p); await esc(p); await wait(p, 400); }],
  ['news terminal', async (p) => { await esc(p); await esc(p); await wait(p, 400); await p.getByRole('button', { name: 'News terminal' }).first().dispatchEvent('click'); await wait(p, 6000); }],
  ['news filters', async (p) => { await p.locator('.nw').getByText(/type/i).first().click({ force: true }); await wait(p, 700); }],
  ['news calendar', async (p) => { await esc(p); await p.locator('.nw').getByText('Calendar').first().click({ force: true }); await wait(p, 2500); }],
  ['add widget', async (p) => { await role(p, 'button', /^New terminal/); }],
  ['feedback dialog', async (p) => { await esc(p); await tap(p, 'Send feedback', 800); }],
  ['keyboard shortcuts', async (p) => { await esc(p); await role(p, 'button', /Keyboard shortcuts/); }],
  settingsSection('Profile'), settingsSection('Privacy'), settingsSection('Layout'), settingsSection('Security'),
  settingsSection('News'), settingsSection('Players & cookies'), settingsSection('Legal'), settingsSection('Help & FAQ'),
  ['connect dialog', async (p) => { await esc(p); await wait(p, 300); await role(p, 'button', 'Connect wallet'); }],
  ['explore markets', async (p) => go(p, '/explore')],
  ['explore gainers list', async (p) => { await tap(p, 'Gainers', 700); }],
  ['explore line chart', async (p) => { await tap(p, 'Line', 1000); }],
  ['explore funding', async (p) => { await tap(p, 'Funding', 2500); }],
  ['explore cohorts', async (p) => { await p.getByRole('link', { name: 'Cohorts' }).or(p.getByText('Cohorts', { exact: true })).first().click({ force: true }); await wait(p, 3500); }],
  ['cohort detail', async (p) => { await p.getByText(/Extremely Profitable/).first().dispatchEvent('click'); await wait(p, 3500); }],
  ['copy grid', async (p) => go(p, '/copy', 7000)],
  ['copy filters', async (p) => { await p.locator('.cpy').getByText('Account value', { exact: false }).first().click({ force: true }); await wait(p, 600); }],
  ['copy sort menu', async (p) => { await esc(p); await tap(p, 'Highest score', 600); }],
  ['copy counter tab', async (p) => { await esc(p); await tap(p, 'Counter-trade', 1500); }],
  ['copy list view', async (p) => { await tap(p, 'Top traders', 800); await p.locator('.cpy button[aria-label*="List" i], .cpy button[title*="List" i]').first().click({ force: true }).catch(() => {}); await wait(p, 1200); }],
  ['copy trader page', async (p) => { await p.locator('.cpy').getByText(/^0x[0-9a-f]{4}/i).first().click({ force: true }); await wait(p, 3500); }],
  ['copy setup', async (p) => { await go(p, '/copy', 7000); await p.locator('.cpy-copybtn--copy').first().click({ force: true }); await wait(p, 5000); }],
  ['copy setup step 2', async (p) => { await p.getByRole('dialog').getByRole('button', { name: 'Next', exact: true }).click({ force: true }); await wait(p, 1500); }],
  ['leaderboard', async (p) => go(p, '/leaderboard', 5000)],
  ['leaderboard inverse', async (p) => { await tap(p, 'Inverse', 2500); }],
  ['leaderboard view', async (p) => { await p.getByRole('button', { name: /^View/ }).first().click({ force: true }); await wait(p, 600); }],
  ['leaderboard platforms', async (p) => { await esc(p); await tap(p, 'All platforms', 500); }],
  ['portfolio', async (p) => go(p, '/portfolio', 4000)],
  ['scan', async (p) => go(p, '/scan', 3000)],
  ['status', async (p) => go(p, '/status', 3500)],
  ['excluded', async (p) => go(p, '/excluded', 3500)],
  ['limits', async (p) => go(p, '/limits', 3500)],
  ['limits rules', async (p) => { await tap(p, 'Trading rules', 500); }],
  ['limits collateral', async (p) => { await tap(p, 'Multi-asset margin', 500); }],
  ['terms page', async (p) => go(p, '/terms', 2500)],
  ['impressum page', async (p) => go(p, '/impressum', 2000)],
  ['terms popup', async (p) => { await p.evaluate(() => { localStorage.removeItem('vd.site.terms.look'); localStorage.removeItem('vd.site.terms.v1'); }); await go(p, '/trade', 4000); }],
];

/** A funded fake account with a position and an order: what only a connected wallet sees. */
const ACCOUNT: Scene[] = [
  ['account trade', async (p) => { await wait(p, 2500); }],
  ['positions', async (p) => { await p.getByRole('group', { name: 'Account activity' }).getByRole('tab', { name: /^Positions/ }).click({ force: true }); await wait(p, 1500); }],
  ['position close ask', async (p) => { await p.getByRole('button', { name: /^Close BTC-USD/ }).first().click({ force: true }); await wait(p, 900); }],
  ['position tp/sl', async (p) => { await esc(p); await wait(p, 300); await p.getByRole('group', { name: 'Account activity' }).getByRole('button', { name: /TP|SL/ }).first().click({ force: true }); await wait(p, 900); }],
  ['open orders', async (p) => { await esc(p); await p.getByRole('group', { name: 'Account activity' }).getByRole('tab', { name: /^Open Orders/ }).click({ force: true }); await wait(p, 1000); }],
  ['balances', async (p) => { await p.getByRole('group', { name: 'Account activity' }).getByRole('tab', { name: /^Balances/ }).click({ force: true }); await wait(p, 800); }],
  ['order review', async (p) => { const t = ticket(p); await t.g.getByText('Limit', { exact: true }).first().click({ force: true }); await p.locator('.oe input').nth(1).fill('0.001').catch(() => {}); await wait(p, 500); await sideButton(p).click({ force: true }); await wait(p, 900); }],
  ['address menu', async (p) => { await esc(p); await wait(p, 300); if (PHONE) await p.getByRole('banner').getByRole('button', { name: /0x[0-9a-f]/i }).first().click({ force: true }); else await p.getByRole('complementary', { name: 'Tools' }).getByRole('button', { name: /^Wallet / }).first().click({ force: true }); await wait(p, 1500); }],
  ['deposit', async (p) => { await esc(p); await wait(p, 300); await role(p, 'button', 'Deposit', 2000); }],
  ['withdraw', async (p) => { await esc(p); await wait(p, 300); await role(p, 'button', 'Withdraw', 1500); }],
  ['transfer', async (p) => { await esc(p); await wait(p, 300); await role(p, 'button', /^Transfer/, 1500); }],
  settingsSection('Profile'), settingsSection('Security'),
  ['algo ticket', async (p) => { await esc(p); await wait(p, 300); await ticket(p).g.getByText('Algo', { exact: true }).first().click({ force: true }); await wait(p, 700); await p.locator('.oe-pop button, .menu-popup button').first().click({ force: true }).catch(() => {}); await wait(p, 1500); }],
  ['portfolio with account', async (p) => go(p, '/portfolio', 4500)],
  ['flow username', async (p) => { await go(p, '/trade', 3000); await p.evaluate(() => window.dispatchEvent(new Event('vd:onboarding'))); await wait(p, 2500); }],
  ['flow username refused', async (p) => { await p.getByRole('textbox', { name: 'Your username' }).fill('sodex_hq'); await wait(p, 500); }],
  ['flow username free', async (p) => { await p.getByRole('textbox', { name: 'Your username' }).fill(`audit_${Date.now().toString(36)}`); await wait(p, 1200); }],
  ['flow referral', async (p) => { await p.getByRole('button', { name: 'Continue', exact: true }).click({ force: true }); await wait(p, 2000); }],
  ['flow traders', async (p) => { const later = p.getByRole('button', { name: 'Not now' }); if (await later.isVisible()) await later.click({ force: true }); await wait(p, 5000); }],
  ['flow copy', async (p) => { await p.getByRole('dialog', { name: 'Getting started' }).getByRole('button', { name: 'Continue', exact: true }).click({ force: true }); await wait(p, 1800); }],
  ['flow heatmap', async (p) => { await p.getByRole('dialog', { name: 'Getting started' }).getByRole('button', { name: 'Continue', exact: true }).click({ force: true }); await wait(p, 1800); }],
  ['flow who traded', async (p) => { await p.getByRole('dialog', { name: 'Getting started' }).getByRole('button', { name: 'Continue', exact: true }).click({ force: true }); await wait(p, 1800); }],
  ['flow overview', async (p) => { await p.getByRole('dialog', { name: 'Getting started' }).getByRole('button', { name: 'Continue', exact: true }).click({ force: true }); await wait(p, 900); }],
  ['flow theme', async (p) => { await p.getByRole('dialog', { name: 'Getting started' }).getByRole('button', { name: 'Continue', exact: true }).click({ force: true }); await wait(p, 1500); }],
  ...[0, 1, 2, 3].map((step): Scene => [`account setup sheet ${step + 1}`, async (p) => {
    if (step === 0) { await p.getByRole('button', { name: 'Skip' }).click({ force: true }).catch(() => {}); await wait(p, 600); }
    await p.evaluate((n) => window.dispatchEvent(new CustomEvent('vs-dev-setup', { detail: { step: n } })), step);
    await wait(p, 1200);
  }]),
  ['paper algo and copies', async (p) => { await esc(p); await go(p, '/portfolio', 3500); }],
];

async function runScenes(first: Page, scenes: Scene[], group: string): Promise<void> {
  let page = first;
  let crashed = false;
  const watch = (p: Page) => p.on('crash', () => { crashed = true; });
  watch(page);
  for (const [name, act] of scenes) {
    if (crashed || page.isClosed()) {
      const origin = new URL(page.url()).origin;
      const ctx = page.context();
      await page.close().catch(() => {});
      page = await ctx.newPage();
      watch(page);
      crashed = false;
      await page.goto(`${origin}/trade`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      await ready(page);
    }
    const scene = `${group}/${name}`;
    if (ONLY && !ONLY.some((w) => scene.includes(w))) continue;
    try {
      await act(page);
      await audit(page, scene);
    } catch (e) {
      covered.push({ scene, ok: false, note: String((e as Error).message).split('\n')[0]!.slice(0, 160) });
      console.log(`  ${scene}: NOT REACHED ${String((e as Error).message).split('\n')[0]!.slice(0, 120)}`);
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
}

async function main(): Promise<void> {
  const origin = process.env.VS_E2E_UI_WEB?.trim() || (await findDevWeb());
  const browser = await launchEdge({});
  const storage: Record<string, string> = { 'vs.theme': THEME, 'vs.setup.done': '1', ...(LANG ? { 'vs.lang.audit': LANG } : {}) };

  // No wallet.
  {
    const wallet = createTestWallet();
    const ctx = await newUiContext(browser, wallet, { ...storage, 'vd.site.terms.look': JSON.stringify('2026-10-28') }, { phone: PHONE });
    if (LANG) await ctx.addInitScript(() => { (window as unknown as { __vsI18nMissing: Set<string> }).__vsI18nMissing = new Set(); });
    const page = await ctx.newPage();
    await page.goto(`${origin}/trade`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await ready(page);
    await runScenes(page, PUBLIC, 'public');
    const sheets = await page.evaluate(() => (window as unknown as { __sheets: () => unknown }).__sheets()) as { rules: number; unresolved: number; flagged: Array<{ selector: string; prop: string; value: string; resolved: string }> };
    const answered = readFileSync(join(SRC, 'theme-light.css'), 'utf8');
    const open = sheets.flagged.filter((f) => !f.selector.split(',').every((s) => answered.includes(s.trim())) && !/data-theme/.test(f.selector));
    writeFileSync(`${OUT}.sheets.json`, JSON.stringify({ rules: sheets.rules, unresolved: sheets.unresolved, open }, null, 1));
    console.log(`sheets: ${sheets.rules} rules, ${open.length} to answer, ${sheets.unresolved} use a local variable`);
    await ctx.close();
  }

  // A funded fake account, with a position and an order.
  {
    const wallet = createTestWallet();
    const ctx = await newUiContext(browser, wallet, storage, { phone: PHONE });
    if (LANG) await ctx.addInitScript(() => { (window as unknown as { __vsI18nMissing: Set<string> }).__vsI18nMissing = new Set(); });
    const page = await ctx.newPage();
    await page.goto(`${origin}/trade`, { waitUntil: 'domcontentloaded' });
    await acceptWelcome(page);
    try {
      await enableTrading({ page, ctx, wallet }, { position: { symbol: 'BTC-USD', size: '0.01', entry: '70000', leverage: 10 }, openOrder: { symbol: 'BTC-USD', side: 'BUY', price: '50000', quantity: '0.01' } });
      await ready(page);
      await runScenes(page, ACCOUNT, 'account');
    } catch (e) {
      covered.push({ scene: 'account', ok: false, note: String((e as Error).message).split('\n')[0]!.slice(0, 160) });
      console.log('account: NOT REACHED', String(e).slice(0, 200));
    }
    await ctx.close();
  }
  await browser.close();

  // One line per distinct problem, with the scenes it showed in.
  const groups = new Map<string, Finding & { scenes: Set<string>; count: number }>();
  for (const f of findings) {
    const k = [f.kind, f.who, f.state, f.fg, f.bg].join('|');
    const g = groups.get(k);
    if (g) { g.count++; g.scenes.add(f.scene); } else groups.set(k, { ...f, scenes: new Set([f.scene]), count: 1 });
  }
  const list = [...groups.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.ratio - b.ratio).map((g) => ({ ...g, scenes: [...g.scenes].slice(0, 4) }));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ covered, findings: list }, null, 1));
  if (LANG) {
    writeFileSync(`${OUT}.missing.json`, JSON.stringify(Object.fromEntries(MISSING), null, 1));
    console.log(`${MISSING.size} pieces of English still on screen in ${LANG}: ${OUT}.missing.json`);
  }
  const ok = covered.filter((c) => c.ok);
  console.log(`\n${ok.length} of ${covered.length} scenes reached; ${ok.reduce((a, c) => a + (c.elements ?? 0), 0)} interactive kinds, ${ok.reduce((a, c) => a + (c.states ?? 0), 0)} forced states`);
  console.log(`${list.filter((f) => f.kind === 'contrast').length} contrast, ${list.filter((f) => f.kind === 'icon').length} icon, ${list.filter((f) => f.kind === 'dark-fill').length} dark-fill distinct findings -> ${OUT}`);
}

await main();
