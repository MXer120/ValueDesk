/**
 * Copy trading terms and risk disclosure - DRAFT for the owner to complete (see
 * model.ts for the markers). Written like terms.ts: for German law and
 * consumers in the EU, the liability clause follows what §§ 307, 309 Nr. 7 BGB
 * allow, and nothing here takes away a consumer's mandatory protection
 * (Art. 6 Rome I).
 *
 * EVERY FOLLOWER SIGNS THESE TERMS. The signed 'accept-terms' request
 * (packages/copy-engine/src/api.ts, AcceptTermsPayload) carries
 * COPY_TERMS_VERSION, a keccak256 of the text the follower saw, the country
 * (the one the edge saw - shown read-only, never picked: owner, 2026-10-28)
 * and the four statements of COPY_STATEMENTS below, and the executor
 * starts no copy under another version (apps/executor/src/service.ts). So any
 * change to the text below raises COPY_TERMS_VERSION in
 * packages/copy-engine/src/policy.ts, and every follower signs again.
 *
 * FACTS, NOT LEGAL CONCLUSIONS. This text never says that a licence is not needed, that the service is not
 * portfolio management or that it is not regulated; the licence status is a
 * placeholder in section 1.
 *
 * The facts it states, as of 2026-10-23:
 *   - leaders, followers, the three modes, the copy rules, copies as IOC limit
 *     orders on SoDEX perps only, SoDEX position stops on the mark price, the
 *     drawdown stop, skips: packages/copy-engine/src/types.ts, orders.ts,
 *     planner.ts, runtime.ts;
 *   - regions (no leverage cap since 2026-11-10), the stricter-country
 *     rule, the copy fee ladder: packages/copy-engine/src/policy.ts - docs.test.ts
 *     checks the ladder, the cap and the excluded countries against it;
 *   - signed instructions (EIP-712) and the append-only consent log:
 *     packages/copy-engine/src/api.ts, apps/executor/src/db.ts;
 *   - the hosted key: generated and sealed (AES-256-GCM) on the executor,
 *     lifetime chosen by the follower up to 180 days (apps/executor/src/
 *     config.ts, secrets.ts); the browser key: at most seven days, in the
 *     browser only; an ordinary SoDEX key - the only kind that can trade - can
 *     also move funds between the owner's own accounts and wallet
 *     (packages/sodex-core/README.md, "Security notes");
 *   - a self-hosted executor reads no fee ledger, so it charges the ladder's
 *     default (apps/executor/src/service.ts volumeOf);
 *   - (2026-10-28) the emergency brake (apps/executor/src/brake.ts): copies
 *     send nothing, live algos are held (not cancelled), algo exits are still
 *     placed, followers can still pause, stop, stop and close, cancel and delete
 *     the key; the hosted keys are sealed with a key-encryption key held on the
 *     same server, so a compromised server means the keys are treated as
 *     exposed (docs/INCIDENT-RUNBOOK.md); only the follower's wallet can revoke
 *     a key on SoDEX. Section 12 follows terms.ts section 16 (see its comment).
 *
 * COPY_RISK_SUMMARY, COPY_STATEMENTS and HOSTED_KEY_NOTICE are shown in the
 * app itself, outside the legal pages, so they may hold no placeholder
 * (docs.test.ts).
 */
import { COPY_TERMS_VERSION } from '../../../../packages/copy-engine/src/policy.ts';
import { copyTermsDoc } from '../../../../packages/copy-engine/src/terms/index.ts';
import type { LegalDoc } from './model';

/**
 * The text of the copy terms in force (COPY_TERMS_VERSION): kept, with every earlier published version, in
 * packages/copy-engine/src/terms/ so the executor can serve exactly what a follower signs (GET /terms/copy). A change
 * to the text is a NEW file there and a new COPY_TERMS_VERSION; a published version is never edited.
 */
export const COPY_TERMS: LegalDoc = copyTermsDoc(COPY_TERMS_VERSION) as LegalDoc;


/** The most important risks, for the copy setup sheet: each one sentence, each standing on its own. */
export const COPY_RISK_SUMMARY: string[] = [
  'You can lose your whole allocation quickly, and with leverage or cross margin more than that - up to everything in your SoDEX perps account.',
  'A trader\'s past results do not predict future results, and nothing on ValueDesk is a recommendation to copy anyone.',
  'The trader you copy has not agreed to be copied, owes you nothing, and can change style, raise leverage, be liquidated or trade against the traders who copy them at any time.',
  'A counter-trade takes the opposite side of the trader: it loses whenever they win, and their good record is then your risk.',
  'Your results will differ from the trader\'s, because copies are placed later, at SoDEX\'s prices, fees and funding, and can be smaller, partly filled or skipped.',
  'In hosted mode, ValueDesk\'s server places your copies around the clock according to your rules, without asking you before each trade.',
  'Outages, delays and software errors can cause missed, late or wrong copies, and your copied positions stay open whenever copying stops.',
  'Anyone who obtains your copy key can trade your SoDEX account and move funds between your own SoDEX accounts and wallet until the key expires or you revoke it on SoDEX.',
  'Every copied order costs a builder fee of up to 0.025% on top of SoDEX\'s fees and funding, which reduces your result even on trades that break even.',
];

/** The statements of AcceptTermsPayload (packages/copy-engine/src/api.ts) a follower ticks before signing. */
export type CopyStatementId = 'adult' | 'notUsPerson' | 'ownDecision' | 'risksUnderstood';

/** The four checkboxes before the follower signs the terms, in the order shown. */
export const COPY_STATEMENTS: Array<{ id: CopyStatementId; label: string }> = [
  { id: 'adult', label: 'I am at least 18 years old and able to enter into binding contracts.' },
  { id: 'notUsPerson', label: 'I am not a US person, I do not live in or connect from the United States or its territories, the United Kingdom or Canada, or from Cuba, Iran, North Korea, Syria, Russia, Belarus or Myanmar, and I do not hide where I am (for example with a VPN).' },
  { id: 'ownDecision', label: 'I chose the trader and every copy rule myself. Nobody, including ValueDesk, recommended them to me.' },
  { id: 'risksUnderstood', label: 'I have read the copy trading terms and risk disclosure, and I understand that I can lose my whole allocation, and with leverage more than that.' },
];

/** Shown before the hosted executor creates the follower's key. */
export const HOSTED_KEY_NOTICE: string =
  'ValueDesk\'s executor will now create a SoDEX API key for you, and you register it on SoDEX with your wallet for the number of days you choose (at most 180). '
  + 'The key is stored encrypted on ValueDesk\'s server in Tokyo, Japan (hosted by Contabo). '
  + 'While it is valid, the executor uses it to place your copies around the clock, according to your copy rules and without asking you before each trade. '
  + 'SoDEX has no key that can trade but cannot move funds: according to SoDEX, this key can also move funds between your own SoDEX spot account, perps account and your own wallet, though not to anyone else. '
  + 'Like any server, it can be attacked: someone who took control of it could use the key until it expires or you revoke it, so choose a short lifetime and keep in your perps account only what you are prepared to have traded. '
  + 'You can stop your copies in the app at any time. To cut the executor off completely, revoke the key on SoDEX with your wallet; once SoDEX has processed that, no order can be placed with it.';

/**
 * The Bots page's setup (CopySetupSteps with `bots`): the same terms and the same four signed statements, worded
 * for a bot. The terms cover bots and copies alike, so a statement ticked here still covers both.
 */
export const BOT_RISK_SUMMARY: string[] = [
  'A bot can lose money even when it trades as designed: what it holds moves with the market, and its fees add up over its volume.',
  'Its loss limit and inventory cap are checked by ValueDesk\'s server while it runs. They are not stop orders on SoDEX: in a fast market or an outage a bot can lose more than its loss limit.',
  'The cost per $1M shown in the app is a figure from past fills, not a promise.',
  'ValueDesk\'s server places your bots\' orders around the clock according to their settings, without asking you before each order. Outages, delays and software errors can cause missed, late or wrong orders.',
  'Anyone who obtains your trading key can trade your SoDEX account and move funds between your own SoDEX accounts and wallet until the key expires or you revoke it on SoDEX.',
  'A bot must not be used to trade with yourself or with accounts you control (no wash trading).',
];

export const BOT_STATEMENT_LABEL: Partial<Record<CopyStatementId, string>> = {
  ownDecision: 'I chose every bot, trader and setting myself. Nobody, including ValueDesk, recommended them to me.',
  risksUnderstood: 'I have read the terms and risk disclosure, and I understand that I can lose money with bots and copies, and with leverage more than I put in.',
};

/** Shown before the hosted executor creates the key a bot trades with. */
export const BOT_HOSTED_KEY_NOTICE: string = HOSTED_KEY_NOTICE
  .replace('to place your copies around the clock, according to your copy rules and', 'to place your bots\' orders around the clock, according to their settings and')
  .replace('You can stop your copies in the app', 'You can stop your bots in the app');
