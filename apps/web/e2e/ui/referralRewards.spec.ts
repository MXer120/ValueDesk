/**
 * The Referrals page's rewards, in the browser with a wallet that really signs:
 *
 *   use a code     offered only to a wallet SoDEX says has no referrer; ValueDesk's code first; another code joins and applies
 *   rewards        the SoDEX sign-in, USDC and fee credits over time, SoPoints by week, traders and history of both kinds
 *   the claim      both at once; one failing never holds back the other; under $1 it waits; signed out it asks for the sign-in
 *   the quota      a code that took its 3 joins of the week (SoDEX's) says so and asks for no signature
 *
 * NOTHING LEAVES THIS MACHINE that could change anything: the referral routes are the server's own code on a store in memory
 * (this process), SoDEX's sign-in, referral and points hosts and the rewards contract are answered here, and an unknown path on
 * any of them is refused. Every figure asserted is worked out from the figures SoDEX is made to send.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page, Route } from 'playwright-core';
import type { BuilderService } from '../../../server/src/builder/service';
import { InviteService } from '../../../server/src/invites/service';
import { InviteStore } from '../../../server/src/invites/store';
import { claimWindow } from '../../../server/src/invites/claim';
import { inviteRoutes } from '../../../server/src/routes/invites';
import { PHONE, connectWallet, uiSuite, until } from './harness';

const h = uiSuite(import.meta.filename);
const D = 86_400_000;
const SIGN_IN = /^Confirm wallet to reveal your SoDEX referral code\. No blockchain transaction or gas fee will occur\.\n\nURI: https:\/\/sodex\.com\nNonce: [A-Za-z0-9]{8,64}\n?$/;
const INVITER = '0x1111111111111111111111111111111111111111';
const CONTRACT = '0x4e0ced3cb2775a82718f9a29c5f86a34169958ec';

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.VS_E2E_REF_SHOTS?.trim();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(dir, `${name}-${PHONE ? 'phone' : 'desktop'}.png`) });
}

/** SoDEX and ValueDesk's referral server, as this test wants them. */
class World {
  wallet = '';
  /** What SoDEX says of the wallet's referrer: nobody, or who. */
  referrer: string | null = null;
  token = 'token-1';
  settled = 12.82;
  claimed = 8.62;
  pending = 1.48;
  unlocked = true;
  claim: 'paid' | 'busy' | 'claimed' = 'paid';
  claimCalls = 0;
  /** Invitees SoDEX lists beyond the two named ones. */
  extraTraders = 0;
  /** Requests answered, and anything asked that this world does not know. */
  readonly seen: string[] = [];
  readonly unknown: string[] = [];
  readonly store = new InviteStore(':memory:', Date.now() - 200 * D);
  readonly svc: InviteService;
  private app: { inject(o: object): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> } | null = null;

  constructor() {
    const builder = {
      tiers: { current: () => ({ builderId: 7 }) },
      store: { wallet: () => null, countedOrders: () => [], tradedMicro: () => ({ perps: 0, spot: 0 }), readThrough: () => 0, oldestOpen: () => null },
      standardFee: () => 15, setExtraPrograms() {}, setPerkBudget() {}, vipNow: () => false, vipProgramOf: () => null,
    } as unknown as BuilderService;
    this.svc = new InviteService(this.store, builder, { isVip: () => false, ownerOf: async (c) => (c === 'FRIEND01' ? INVITER : null), inviterOf: async () => null });
  }

  earn(usd: number, at: number, tier: number, n: string): void {
    this.store.take(`e:${n}`, n, 1, [{ address: this.wallet, kind: 'earn', micro: usd * 1e6, source: '0xc04f0000000000000000000000000000000071aa', tier }], at);
  }

  private async api(route: Route): Promise<void> {
    const q = route.request();
    const u = new URL(q.url());
    if (!this.app) {
      const Fastify = createRequire(new URL('../../../server/package.json', import.meta.url))('fastify') as (o: object) => { register(p: unknown, o: object): Promise<unknown> } & World['app'];
      const app = Fastify({ logger: false })!;
      await app.register(inviteRoutes, { service: this.svc, keep: false });
      this.app = app;
    }
    const r = await this.app!.inject({ method: q.method(), url: u.pathname + u.search, headers: { 'content-type': 'application/json' }, ...(q.postData() ? { payload: q.postData()! } : {}) });
    await route.fulfill({ status: r.statusCode, contentType: 'application/json', body: r.body });
  }

  private week(n: number, points: number, ref: number, status = 'CONFIRMED') {
    return { weekNo: n, weekName: `Week ${n}`, status: 'COMPLETED', weekStartTime: 1_788_264_000 + (n - 1) * 604_800, weekEndTime: 0, distributionTime: 0, isLive: false, spotVolume: 0, futuresVolume: 9_000, vaultHolding: 0, wealthTvl: 0, oi: 0, accountValue: 0, teamWeekVolume: 0, teamWindowVolume: 0, totalBonusPct: 20, points, referralPoints: ref, pointsStatus: status, rank: 1, totalUser: 2, rankPercentile: '' };
  }

  private async sodex(route: Route): Promise<void> {
    const q = route.request();
    const u = new URL(q.url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (q.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const p = u.pathname;
    this.seen.push(`${q.method()} ${p}`);
    const ok = (data: unknown) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 0, msg: 'success', data }) });
    if (p === '/biz/referral/public/referralCode') return ok({ referralCode: 'MYCODE99', eligible: true });
    if (p === '/biz/referral/checkEligibility') {
      const code = u.searchParams.get('referralCode');
      const owner = code === 'VALUEDESK' ? '0x1e43000000000000000000000000000000000000' : code === 'FRIEND01' ? INVITER : code === 'MYCODE99' ? this.wallet : null;
      if (code) return ok(owner ? { inviterWalletAddress: owner, needSignature: false } : null);
      return ok({ inviterWalletAddress: this.referrer ?? '', needSignature: false });
    }
    if (p.startsWith('/biz/sopoints/v2/week/info')) return ok({ weekNo: 13, weekName: 'Week 13', weekStatus: 'LIVE', weekPoolPoints: 900000, nextWeekStartTime: 1796126400, distributionTime: 1796385600 });
    if (p.startsWith('/biz/announcements') || p.startsWith('/biz/v1/maintenance') || p.startsWith('/biz/v1/ext-chain') || p.startsWith('/biz/config') || p.startsWith('/biz/futures') || p.startsWith('/biz/spot') || p.startsWith('/biz/mirror') || p.startsWith('/biz/soso_airdrop')) return ok(null);
    // Everything else needs the token, as SoDEX's.
    if (q.headers().authorization !== `Bearer ${this.token}`) return route.fulfill({ status: 401, headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 401, msg: 'Unauthorized: missing bearer token' }) });
    if (p === '/biz/referral/myStats') return ok({ eligible: true, referrerState: { stage: 'ready', data: { code: 'MYCODE99', canModify: false, totalReferrals: 2 } }, earnedRewardsOnChain: String(this.settled), totalFeesEarned: this.settled + this.pending, pendingRewards: this.pending, cumVlm: this.unlocked ? 48_000 : 800, vlmThreshold: 2000, vaultNetStake: 0, vaultNetStakeThreshold: 500, weeklyInviteCount: 2, maxInvitesPerWeek: 100, nextAvailableTime: null, referredBy: null, bonusDistributions: [] });
    if (p === '/biz/referral/myClaimHistory') return ok({ total: 2, list: [{ fees: '5.44', txHash: `0x${'a'.repeat(64)}`, time: Date.now() - 5 * D }, { fees: '3.18', txHash: `0x${'b'.repeat(64)}`, time: Date.now() - 12 * D }] });
    if (p === '/biz/referral/myList') return ok({ total: 2 + this.extraTraders, list: [...Array.from({ length: this.extraTraders }, (_, i) => ({ inviteeWallet: `0x77${String(i).padStart(38, '0')}`, referralCode: 'MYCODE99', volume: 5_000 + i, paidFees: 1, yourRewardedFees: 0.1, yourRewardedPoints: 1, referralTime: Date.now() - 40 * D })),{ inviteeWallet: '0xc04f0000000000000000000000000000000071aa', referralCode: 'MYCODE99', volume: 210_000, paidFees: 80, yourRewardedFees: 8, yourRewardedPoints: 640, referralTime: Date.now() - 20 * D }, { inviteeWallet: '0x66aa0000000000000000000000000000000010f3', referralCode: 'MYCODE99', volume: 88_000, paidFees: 23, yourRewardedFees: '2.3', yourRewardedPoints: 96, referralTime: Date.now() - 30 * D }] });
    if (p === '/biz/sopoints/v2/summary') return ok({ totalPoints: 666, currentTier: 'Silver', nextTier: 'Gold', nextTierPoints: 1000, referralPoints: 100 });
    if (p === '/biz/sopoints/v2/week/list') return ok([this.week(1, 120, 20), this.week(2, 240, 60), this.week(3, 0, 0, 'TBD')]);
    if (p === '/biz/sopoints/week/list') return ok([]);
    if (p === '/biz/sopoints/v2/team/bonus') return ok(null);
    if (p === '/biz/airdrop/v1/referral_claim' && q.method() === 'POST') {
      this.claimCalls++;
      const err = (code: number, msg: string) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ code, msg, data: null }) });
      if (this.claim === 'busy') return err(-3000010, 'rate limited');
      if (this.claim === 'claimed') return err(-3001111, 'already claimed');
      const usd = Math.floor((this.settled - this.claimed) * 100 + 1e-6) / 100;
      this.claimed += usd;
      return ok({ results: [{ amount: String(usd), status: 1, txHash: `0x${'c'.repeat(64)}` }] });
    }
    this.unknown.push(`${q.method()} ${p}`);
    return route.fulfill({ status: 404, headers: cors, body: '' });
  }

  private async chain(route: Route): Promise<void> {
    const q = route.request();
    if (q.method() !== 'POST') return route.continue();
    const body = JSON.parse(q.postData() ?? '{}') as { id?: number; method?: string; params?: Array<{ to?: string; data?: string }> } | unknown[];
    if (Array.isArray(body)) return route.continue();
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }) });
    if (body.method === 'eth_call' && body.params?.[0]?.to?.toLowerCase() === CONTRACT) {
      assert.equal(body.params[0].data!.slice(0, 10), '0x8383aa93');
      assert.equal(body.params[0].data!.slice(74, 138), this.wallet.slice(2).toLowerCase().padStart(64, '0'));
      return ok(`0x${Math.round(this.claimed * 1e6).toString(16).padStart(64, '0')}`);
    }
    if (body.method === 'eth_getTransactionReceipt') return ok({ status: '0x1', logs: [] });
    return route.continue();
  }

  async install(ctx: BrowserContext): Promise<void> {
    // Nothing of the app's own servers is changed by a test (terms, analytics, …): only reads pass, and what is answered below.
    await ctx.route((u) => u.pathname.startsWith('/api/'), (r) => (r.request().method() === 'GET' ? r.fallback() : r.abort()));
    await ctx.route((u) => u.pathname.startsWith('/api/vs/invites/'), (r) => this.api(r));
    await ctx.route((u) => u.pathname === '/api/vs/sopoints/log', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"rows":0}' }));
    await ctx.route((u) => u.pathname === '/api/vs/sodex-auth/nonce', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, message: 'Confirm wallet to reveal your SoDEX referral code. No blockchain transaction or gas fee will occur.\n\nURI: https://sodex.com\nNonce: abcdEFGH1234\n' }) }));
    await ctx.route((u) => u.pathname === '/api/vs/sodex-auth/verify', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, accessToken: this.token }) }));
    await ctx.route((u) => u.hostname === 'alpha-biz.sodex.dev', (r) => this.sodex(r));
    await ctx.route((u) => u.hostname === 'rpc.valuechain.xyz', (r) => this.chain(r));
    // sodex.com's own join page is never opened by a test.
    await ctx.route((u) => u.hostname === 'sodex.com', (r) => r.abort());
  }
}

const world = { current: new World() };
const setup = async (ctx: BrowserContext) => { world.current = new World(); await world.current.install(ctx); };

/** Connected, on the Referrals page. */
async function arrive(page: Page, wallet: { address: string }): Promise<World> {
  const w = world.current;
  w.wallet = wallet.address.toLowerCase();
  await connectWallet(page);
  await page.evaluate(() => { history.pushState({}, '', '/referrals'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await page.getByRole('heading', { name: 'Referrals', exact: true }).waitFor();
  return w;
}
const claimField = (page: Page) => page.getByRole('region', { name: 'Weekly claim' });

h.test('use a code: only for a wallet without a referrer; ValueDesk first; a wrong code says so; another code joins and is applied', async ({ page, wallet }) => {
  const w = await arrive(page, wallet);
  const button = page.getByRole('button', { name: 'Use a code', exact: true });
  await button.waitFor({ timeout: 20_000 });
  await button.click();
  const dlg = page.getByRole('dialog', { name: 'Use a code' });
  const field = dlg.getByRole('textbox', { name: 'Referral code' });
  assert.equal(await field.inputValue(), 'VALUEDESK');
  await dlg.getByText("ValueDesk's code", { exact: true }).waitFor();
  // ValueDesk's own code refers nobody on ValueDesk: no fee perk is promised, no signature asked.
  assert.equal(await dlg.getByText('$0', { exact: true }).count(), 0);
  assert.equal(await dlg.getByRole('button', { name: 'Sign', exact: true }).count(), 0);
  assert.equal(await dlg.getByRole('link', { name: 'Apply', exact: true }).getAttribute('href'), 'https://sodex.com/join/VALUEDESK');
  await shot(page, 'code-valuedesk');
  for (const [code, says] of [['NOBODY12', 'SoDEX has no such code'], ['AB', '4 to 20 letters and numbers'], ['MYCODE99', 'Your own code']] as const) {
    await field.fill(code);
    await dlg.getByText(says, { exact: true }).waitFor();
    assert.equal(await dlg.getByRole('link', { name: 'Apply', exact: true }).count(), 0, `${code}: nothing to apply`);
  }
  await field.fill('friend01');
  await dlg.getByText('Valid', { exact: true }).waitFor();
  await dlg.getByText('$0', { exact: true }).waitFor();
  const mark = wallet.mark();
  await dlg.getByRole('button', { name: 'Sign', exact: true }).click();
  await dlg.getByText('Joined', { exact: true }).waitFor({ timeout: 20_000 });
  assert.deepEqual(wallet.since(mark).filter((r) => r.outcome === 'signed').map((r) => r.primaryType), ['InviteJoin']);
  assert.equal(w.store.joinOf(w.wallet)?.code, 'FRIEND01');
  assert.equal(await field.isDisabled(), true, 'the code is settled');
  assert.equal(await dlg.getByRole('link', { name: 'Apply', exact: true }).getAttribute('href'), 'https://sodex.com/join/FRIEND01');
  // The wallet confirmed on sodex.com and came back.
  w.referrer = INVITER;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.getByRole('dialog', { name: 'Code applied' }).waitFor({ timeout: 15_000 });
  await shot(page, 'code-applied');
  await page.getByRole('dialog', { name: 'Code applied' }).getByRole('button', { name: 'Done', exact: true }).click();
  await button.waitFor({ state: 'hidden', timeout: 10_000 });
  assert.deepEqual(w.unknown, []);
}, { setup, timeout: 120_000 });

h.test('use a code: never for a wallet with a referrer, nor while SoDEX has not said', async ({ page, wallet }) => {
  world.current.referrer = INVITER;
  await arrive(page, wallet);
  await page.waitForTimeout(3_000);
  assert.equal(await page.getByRole('button', { name: 'Use a code', exact: true }).count(), 0);
}, { setup, timeout: 120_000 });

h.test('rewards: signed out nothing is made up; signed in every figure is SoDEX\'s; both kinds under the pointer, by day, in the list and the history; SoPoints by week', async ({ page, wallet }) => {
  const w = await arrive(page, wallet);
  w.referrer = INVITER;
  const cw = claimWindow(Date.now());
  w.earn(2.5, cw.opensAt - 2 * D, 1, 'a');
  w.earn(0.75, cw.opensAt - D, 2, 'b');
  w.earn(0.4, Date.now() - 60_000, 1, 'c');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Referrals', exact: true }).waitFor();
  const panel = page.getByRole('region', { name: 'Rewards earned' });
  // What was claimed is on chain, and shows without a sign-in; what is earned in all does not.
  await panel.getByText('+$8,62', { exact: false }).waitFor({ timeout: 20_000 });
  await panel.getByText('claimed', { exact: true }).waitFor();
  await panel.getByText('+$3,65', { exact: true }).waitFor();
  const field = claimField(page);
  await field.getByText('Sign in to SoDEX to see it', { exact: true }).waitFor();
  await panel.getByRole('radio', { name: 'SoPoints', exact: true }).click();
  const sign = page.getByRole('button', { name: 'Sign in to SoDEX', exact: true });
  await sign.waitFor();
  await shot(page, 'signin');
  // A rejected signature is no error; then the real one: SoDEX's text, nothing else.
  await sign.click();
  await page.waitForTimeout(1_500);
  wallet.messages = SIGN_IN;
  const mark = wallet.mark();
  await sign.click();
  const points = page.getByRole('region', { name: 'SoPoints earned' });
  await points.getByText('360', { exact: true }).waitFor({ timeout: 20_000 }); // 120 + 240; the unscored week is not a 0
  await points.getByText('80', { exact: true }).waitFor(); // 20 + 60 from invitees
  assert.deepEqual(wallet.since(mark).map((r) => `${r.method} ${r.outcome}`), ['personal_sign signed']);
  // By week: the bars, then the grid.
  const bars = points.locator('.rfc.is-bars');
  if (PHONE) await bars.tap({ position: { x: 10, y: 60 } }); else await bars.hover({ position: { x: 10, y: 60 } });
  await points.locator('.rfc__tip').getByText('Layer 1 · Week 1').waitFor();
  const tip = await points.locator('.rfc__tip').innerText();
  assert.match(tip, /From invitees\s*20/);
  assert.doesNotMatch(tip, /Own|Boost/, 'only what invitees brought');
  await shot(page, 'points');
  await points.getByRole('radio', { name: 'Calendar', exact: true }).click();
  await points.getByRole('button', { name: /^From invitees \(25%\), Layer 1 · Week 2.*: 60$/ }).waitFor();
  // Rewards: 12.82 settled + 1.48 pending.
  await points.getByRole('radio', { name: 'Rewards', exact: true }).click();
  await panel.getByText('+$14,30', { exact: true }).waitFor();
  await panel.getByRole('button', { name: /^USDC claimed, .*: \$5,44$/ }).waitFor();
  await panel.getByRole('button', { name: /^Credits, tier 2, .*: \$0,7500$/ }).waitFor();
  await shot(page, 'calendar');
  await panel.getByRole('radio', { name: 'Chart', exact: true }).click();
  const chart = panel.locator('.rfc');
  const box = (await chart.boundingBox())!;
  if (PHONE) await chart.tap({ position: { x: box.width - 2, y: 60 } }); else await chart.hover({ position: { x: box.width - 2, y: 60 } });
  assert.match(await panel.locator('.rfc__tip').innerText(), /USDC\s*\$14,30[\s\S]*Fee credits\s*\$3,65/);
  // Between two points the pointer reads where it is: the line moves with it, never jumps to a point.
  const lefts: string[] = [];
  for (const k of [0.3, 0.33, 0.36]) {
    if (PHONE) await chart.tap({ position: { x: box.width * k, y: 60 } }); else await chart.hover({ position: { x: box.width * k, y: 60 } });
    lefts.push(await panel.locator('.rfc__x').evaluate((e) => (e as HTMLElement).style.left));
  }
  assert.equal(new Set(lefts).size, 3, `the cross follows the pointer: ${lefts.join(' ')}`);
  await shot(page, 'chart');
  // The card and the field: claimable is 12.82 - 8.62.
  await page.getByRole('region', { name: 'Your rewards' }).getByText('$4,20', { exact: true }).waitFor();
  await field.getByText('$4,20', { exact: true }).waitFor();
  await field.getByText('$3,25', { exact: true }).waitFor(); // 2.50 + 0.75: the week that ended
  await field.getByText('$0,40 pending', { exact: true }).waitFor(); // two decimals
  // Traders: SoDEX's invitee and its rebate; the history: both kinds.
  const list = page.getByRole('region', { name: 'Your traders' });
  await list.getByText('0xc04f…71aa', { exact: true }).waitFor();
  await list.getByText('+$8,00', { exact: false }).first().waitFor();
  await list.getByRole('radio', { name: 'History', exact: true }).click();
  await list.getByText('USDC claimed', { exact: true }).first().waitFor();
  await list.getByText('+$2,50', { exact: false }).first().waitFor();
  assert.equal(await list.getByRole('link', { name: 'USDC claimed' }).first().getAttribute('href'), `https://main-scan.valuechain.xyz/tx/0x${'a'.repeat(64)}`);
  await shot(page, 'history');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'nothing runs off the side');
  // The sign-in ends at SoDEX: the page asks again, and never shows a 0 for it.
  w.token = 'token-2';
  await page.evaluate(() => { sessionStorage.setItem('ot.sopoints.token', JSON.stringify({ address: 'x', token: 'x' })); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await field.getByText('Sign in to SoDEX to see it', { exact: true }).waitFor({ timeout: 20_000 });
  assert.deepEqual(w.unknown, []);
}, { setup, timeout: 180_000 });

h.test('the claim: both at once, one signature; claimed once; the figures follow', async ({ page, wallet }) => {
  const w = await arrive(page, wallet);
  w.referrer = INVITER;
  const cw = claimWindow(Date.now());
  w.earn(2, cw.opensAt - D, 1, 'a');
  wallet.messages = SIGN_IN;
  await page.reload({ waitUntil: 'domcontentloaded' });
  const field = claimField(page);
  await field.getByRole('button', { name: 'Claim', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Weekly claim' });
  await dlg.getByRole('button', { name: 'Sign in', exact: true }).click();
  const both = dlg.getByRole('button', { name: 'Claim both', exact: true });
  await both.waitFor({ timeout: 20_000 });
  await shot(page, 'claim-open');
  const mark = wallet.mark();
  await both.click();
  const done = page.getByRole('dialog', { name: 'Claimed' });
  await done.waitFor({ timeout: 30_000 });
  await done.getByText('+$4,20', { exact: true }).waitFor();
  await done.getByText('+$2,00', { exact: true }).waitFor();
  assert.equal(await done.getByRole('link', { name: 'See the transaction' }).getAttribute('href'), `https://main-scan.valuechain.xyz/tx/0x${'c'.repeat(64)}`);
  await shot(page, 'claim-done');
  assert.deepEqual(wallet.since(mark).map((r) => `${r.primaryType} ${r.outcome}`), ['CreditClaim signed'], 'one signature, for the credits only');
  assert.equal(w.claimCalls, 1);
  assert.equal(w.store.claimOf(w.wallet, cw.week)?.micro, 2e6);
  assert.equal(w.store.totals(w.wallet).balance, 2e6);
  await done.getByRole('button', { name: 'Close', exact: true }).last().click();
  await field.getByText('Claimed', { exact: false }).first().waitFor();
  await page.getByRole('region', { name: 'Your rewards' }).getByText('$2,00', { exact: true }).waitFor();
  await until(page, async () => /\$0,00/.test(await page.getByRole('region', { name: 'Your rewards' }).innerText()), 'USDC to claim back to 0', 15_000);
  // Again: nothing to claim, nothing sent.
  await field.getByRole('button', { name: 'Claim', exact: true }).click();
  const again = page.getByRole('dialog', { name: 'Weekly claim' });
  assert.equal(await again.getByRole('button', { name: 'Nothing to claim', exact: true }).isDisabled(), true);
  assert.equal(w.claimCalls, 1);
}, { setup, timeout: 120_000 });

h.test('signed out, the popup asks for the SoDEX sign-in, never "Nothing to claim"; credits under $1 wait; traders and history by page', async ({ page, wallet }) => {
  const w = await arrive(page, wallet);
  w.referrer = INVITER;
  w.extraTraders = 9;
  const cw = claimWindow(Date.now());
  w.earn(0.6, cw.opensAt - D, 1, 'a');
  for (let i = 0; i < 12; i++) w.earn(0.01, cw.opensAt - (i + 2) * 3_600_000, 1, `h${i}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const field = claimField(page);
  await field.getByText('Claimable from $1,00', { exact: true }).waitFor({ timeout: 20_000 });
  await field.getByRole('button', { name: 'See my rewards', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Weekly claim' });
  await dlg.getByRole('button', { name: 'Sign in to SoDEX', exact: true }).waitFor();
  assert.equal(await dlg.getByRole('button', { name: 'Nothing to claim' }).count(), 0);
  assert.equal(await dlg.getByRole('button', { name: 'Sign in', exact: true }).count(), 0, 'one sign-in button');
  await dlg.getByText('Claimable from $1,00. They stay yours until then', { exact: true }).waitFor();
  await shot(page, 'claim-signedout');
  wallet.messages = SIGN_IN;
  await dlg.getByRole('button', { name: 'Sign in to SoDEX', exact: true }).click();
  await dlg.getByRole('button', { name: /^Claim \$4,20 USDC$/ }).waitFor({ timeout: 20_000 });
  await dlg.getByRole('button', { name: 'Not now', exact: true }).click();
  // 11 traders (9 + SoDEX's 2): 6 a page.
  const list = page.getByRole('region', { name: 'Your traders' });
  await list.getByText('Page 1 / 2', { exact: true }).waitFor({ timeout: 20_000 });
  assert.equal(await list.locator('.rf-list > li').count(), 6);
  await list.getByRole('button', { name: 'Next page' }).click();
  await list.getByText('Page 2 / 2', { exact: true }).waitFor();
  assert.equal(await list.locator('.rf-list > li').count(), 5);
  // History: 13 credits + 2 USDC claims, 8 a page.
  await list.getByRole('radio', { name: 'History', exact: true }).click();
  await list.getByText('Page 1 / 2', { exact: true }).waitFor();
  assert.equal(await list.locator('tbody tr').count(), 8);
  await shot(page, 'pages');
  assert.deepEqual(w.unknown, []);
}, { setup, timeout: 120_000 });

h.test("SoDEX's quota: a code that took its 3 joins this week says so, and no signature is asked", async ({ page, wallet }) => {
  const w = await arrive(page, wallet);
  for (let i = 0; i < 3; i++) w.store.join({ wallet: `0x88${String(i).padStart(38, '0')}`, code: 'FRIEND01', statement: '', nonce: 'n', issuedAt: '0', expiresAt: '0', chainId: 1, signature: '0x' }, INVITER, { hasVolume: false, welcome: true }, Date.now() - 60_000);
  await page.getByRole('button', { name: 'Use a code', exact: true }).click({ timeout: 20_000 });
  const dlg = page.getByRole('dialog', { name: 'Use a code' });
  const field = dlg.getByRole('textbox', { name: 'Referral code' });
  await field.fill('FRIEND01');
  await dlg.getByText('Full this week', { exact: true }).waitFor({ timeout: 15_000 });
  await dlg.getByText(/took its 3 joins this week, SoDEX's limit\. It takes new ones from Monday/).waitFor();
  assert.equal(await dlg.getByRole('button', { name: 'Sign', exact: true }).count(), 0);
  await shot(page, 'code-full');
  assert.equal(w.store.joinOf(w.wallet), null);
}, { setup, timeout: 120_000 });

h.test('the claim: SoDEX busy never holds back the credits; a rejected signature leaves them; under a dollar SoDEX is not asked', async ({ page, wallet }) => {
  const w = await arrive(page, wallet);
  w.referrer = INVITER;
  w.claim = 'busy';
  const cw = claimWindow(Date.now());
  w.earn(2, cw.opensAt - D, 1, 'a');
  wallet.messages = SIGN_IN;
  await page.reload({ waitUntil: 'domcontentloaded' });
  const field = claimField(page);
  await field.getByRole('button', { name: 'Claim', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Weekly claim' });
  await dlg.getByRole('button', { name: 'Sign in', exact: true }).click();
  await dlg.getByRole('button', { name: 'Claim both', exact: true }).waitFor({ timeout: 20_000 });
  wallet.reject.add('credit-claim');
  await dlg.getByRole('button', { name: 'Claim both', exact: true }).click();
  await dlg.getByText('SoDEX is busy. Try again in a minute.', { exact: true }).waitFor({ timeout: 20_000 });
  assert.equal(w.store.claimOf(w.wallet, cw.week), null, 'rejected: nothing claimed, still open');
  wallet.reject.clear();
  await dlg.getByRole('button', { name: 'Claim both', exact: true }).click();
  await until(page, () => w.store.claimOf(w.wallet, cw.week) !== null, 'the credits claimed', 20_000);
  await dlg.getByText('SoDEX is busy. Try again in a minute.', { exact: true }).waitFor();
  await dlg.getByRole('button', { name: /^Claim \$4,20 USDC$/ }).waitFor();
  await shot(page, 'claim-busy');
  await dlg.getByRole('button', { name: 'Not now', exact: true }).click();
  // Under a dollar: said, and not asked for.
  w.settled = w.claimed + 0.6;
  const calls = w.claimCalls;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await field.getByText('SoDEX pays out from $1,00', { exact: true }).waitFor({ timeout: 20_000 });
  assert.equal(w.claimCalls, calls);
}, { setup, timeout: 120_000 });
