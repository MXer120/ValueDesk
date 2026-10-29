/**
 * The bootstrap every run begins with (the executor's data is new each run):
 * the copy terms signed with the owner's declared country, the executor's key
 * made and registered on SoDEX with the follower's wallet (what copy setup's
 * "Approve agent" does), and the builder-fee approval the copy fee needs. They
 * run every time and are recorded like any scenario.
 *
 * And one resumable scenario: a key the follower made themselves, brought to
 * the executor (key import), trading for real; then the executor's own key is
 * registered again so the rest of the suite uses it.
 */
import { COPY_TERMS_VERSION } from '../../../../../packages/copy-engine/src/index.ts';
import { generateTradingKey } from '../../../../../packages/sodex-core/src/index.ts';
import { sealForImport } from '../../../../web/src/copy/keyImport.ts';
import type { T } from '../harness.ts';
import type { Scenario } from '../scenario.ts';

const SOURCE = 'apps/executor/tools/live-test/scenarios/setup.ts';
const DAY = 86_400_000;

/** Make the executor's key, register it on SoDEX with the follower's wallet, and wait until the executor reads it as registered. */
export async function registerExecutorKey(t: T): Promise<void> {
  const k = await t.exec.createKey(1);
  t.check(/^0x[0-9a-f]{40}$/.test(k.address), `the executor made a key ${k.address} (${k.name})`);
  await t.live('the key is registered on SoDEX and the executor reads it as registered', async () => {
    const { expiresAt } = await t.env.follower!.registerKey(k.name, k.address, 1);
    const key = await t.waitFor('the executor sees the key on SoDEX', async () => {
      const x = await t.exec.verifyKey();
      return x?.registered && x.address.toLowerCase() === k.address.toLowerCase() ? x : null;
    }, { timeoutMs: 60_000, everyMs: 3_000 });
    t.check(key.expiresAt !== null && Math.abs(key.expiresAt - expiresAt) < 120_000 && key.expiresAt <= Date.now() + DAY + 60_000, 'it expires within a day, as registered', { expiresAt: key.expiresAt });
    const listed = await t.env.reads.apiKeys(t.env.followerAddress);
    t.check(listed.some((r) => r.name === k.name && r.publicKey.toLowerCase() === k.address.toLowerCase()), `SoDEX lists ${k.name} on the follower's perps account`);
  });
}

export const SETUP_SCENARIOS: Scenario[] = [
  {
    id: 'setup.terms',
    section: 'setup',
    kind: 'key',
    title: 'Copy terms accepted with the declared country',
    confirms: 'the executor records the signed terms and the region rule of the declared country',
    deps: [],
    source: SOURCE,
    always: true,
    dry: 'full',
    timeoutMs: 60_000,
    cost: () => ({ takerUsd: 0, makerUsd: 0, peakUsd: 0 }),
    async run(t) {
      const me = await t.exec.acceptTerms(t.env.country, t.env.termsHash);
      t.check(me.terms?.termsVersion === COPY_TERMS_VERSION, `terms ${COPY_TERMS_VERSION} recorded`);
      t.check(me.policy.allowed, `copying is allowed for ${t.env.country}`, me.policy.reason);
      t.check(me.policy.maxLeverage === t.env.regionMaxLeverage, `the region's leverage cap is ${me.policy.maxLeverage ?? 'none'}`);
    },
  },
  {
    id: 'setup.key',
    section: 'setup',
    kind: 'key',
    title: 'The executor\'s key registered on SoDEX with the follower\'s wallet',
    confirms: 'SoDEX accepts the registration the web app sends (exchange route, perps only, one day) and lists the key',
    deps: [],
    source: SOURCE,
    always: true,
    dry: 'full',
    timeoutMs: 2 * 60_000,
    cost: () => ({ takerUsd: 0, makerUsd: 0, peakUsd: 0, walletSignatures: 1 }),
    run: registerExecutorKey,
  },
  {
    id: 'setup.builder',
    section: 'setup',
    kind: 'key',
    title: 'The builder fee approved for the copy fee ladder\'s top step',
    confirms: 'SoDEX lists the follower\'s approval of the builder at >= 2.5 bp (approved here only if it was lower)',
    deps: [],
    source: SOURCE,
    always: true,
    dry: 'full',
    timeoutMs: 60_000,
    cost: () => ({ takerUsd: 0, makerUsd: 0, peakUsd: 0, walletSignatures: 1 }),
    async run(t) {
      const info = await t.exec.info();
      // None (a dev web without VITE_BUILDER_ID, on the browser target; a live run there refuses it) is 0, as the runner counts it.
      t.check((info.builder?.id ?? 0) === t.env.builderId, `the executor's orders carry builder ${info.builder?.id ?? 'none'}`);
      await t.live(`SoDEX lists an approval of builder ${t.env.builderId} at >= ${t.env.builderFee / 10} bp`, async () => {
        let rate = await t.env.reads.builderApproval(t.env.followerAddress, t.env.builderId);
        t.note(`approval before: ${rate ?? 'none'}`);
        if (rate === null || rate < t.env.builderFee) rate = await t.env.follower!.approveBuilder(t.env.builderId, t.env.builderFee);
        t.check(rate !== null && rate >= t.env.builderFee, `approved ${rate}`);
      });
    },
  },
  {
    id: 'setup.key-import',
    section: 'setup',
    kind: 'key',
    title: 'A key the follower made, imported into the executor, trades',
    confirms: 'an imported key that SoDEX lists under its own name signs real orders; the executor\'s own key is registered again after',
    deps: [],
    source: SOURCE,
    // A browser makes its own copy key: nothing is imported into it.
    needs: ['keyImport'],
    dry: 'spec',
    timeoutMs: 4 * 60_000,
    cost: (U) => ({ takerUsd: 4 * U, makerUsd: 0, peakUsd: 2 * U, walletSignatures: 2 }),
    async run(t) {
      const info = await t.exec.info();
      t.check(!!info.keyImport?.publicKey && info.features?.includes('key-import') === true, 'the executor offers key import');
      await t.live('import, trade with the imported key, register the executor\'s key again', async () => {
        const k = generateTradingKey();
        const name = 'vd-livetest-imp';
        await t.env.follower!.registerKey(name, k.address, 1);
        await t.waitFor('SoDEX lists the follower\'s own key', async () => ((await t.env.reads.apiKeys(t.env.followerAddress)).some((r) => r.name === name && r.publicKey.toLowerCase() === k.address.toLowerCase()) ? true : null), { timeoutMs: 30_000 });
        const env = await sealForImport(info.keyImport!.publicKey, info.keyImport!.info.replace('<owner>', t.env.followerAddress), k.privateKey);
        const key = await t.exec.importKey(name, env);
        t.check(key?.address.toLowerCase() === k.address.toLowerCase() && key.registered && key.name === name, 'the imported key is the active one');
        const v0 = await t.start({ kind: 'swarm', quantity: await t.qty(2 * t.U), clips: 2, inFlight: 2, waveMs: 0, slippageBps: 20 });
        const v = await t.waitAlgo(v0.algo.id, 'the order signed with the imported key filled', (x) => x.algo.status === 'done', { timeoutMs: 90_000 });
        t.check(v.algo.filled > 0, `filled ${v.algo.filled}`);
      });
      await registerExecutorKey(t);
    },
  },
];
