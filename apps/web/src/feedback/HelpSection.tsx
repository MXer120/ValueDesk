/**
 * Settings -> Help & FAQ (owner, 2026-10-27: "make place for a Frequently asked
 * questions tab & a send feedback button there too").
 *
 * Every answer says what the code does today - the copy modes and their keys
 * (packages/copy-engine, apps/executor), the fee ladder (copy-engine policy.ts
 * COPY_FEE_LADDER, docs/BUILDER-TIERS.md), algo orders and practice runs
 * (docs/ALGO-ORDERS.md), the regional rules (legal/jurisdictions.mjs), where it
 * runs (docs/deploy). Change an answer when the code changes; never promise
 * more. faq.test.ts pins the figures to their sources.
 */
import { LegalLink } from '../legal/LegalGate';
import { STATUS_PATH } from '../router';
import { FeedbackIcon, openFeedback } from './FeedbackButton';

export interface Faq {
  q: string;
  a: string;
}

export const FAQ: readonly Faq[] = [
  {
    q: 'What is ValueDesk?',
    a: 'A trading terminal for SoDEX perpetuals and spot, with leaderboards and trader analytics, copy trading and algo orders. It is not an exchange: every order goes to SoDEX, in your own SoDEX account.',
  },
  {
    q: 'Does ValueDesk hold my funds?',
    a: 'No. Your funds stay in your own SoDEX account, and ValueDesk never has your wallet\'s private key. To trade, your wallet registers a SoDEX API key: this browser makes one for the terminal, and each copy mode has its own copy key. Like any SoDEX key, such a key can place and cancel orders and move funds between your own SoDEX accounts. In Settings - Security you can ask for a password or passkey before money moves.',
  },
  {
    q: 'How does copy trading run?',
    a: 'In one of three places, on one engine: in this browser (while a ValueDesk tab is open), on the ValueDesk executor (24/7, on our server in Japan) or self-hosted (the copier on your own computer). Copies are made on SoDEX perps in your own account, with your own rules; every start, change and stop is signed by your wallet. A paper copy follows the trader and sends nothing.',
  },
  {
    q: 'What does it cost?',
    a: 'ValueDesk adds a builder fee to the orders it places, which you approve on SoDEX once; SoDEX\'s own trading fees come on top. Orders from the terminal: 0.015% (1.5 bp) by default. Copied orders and algo orders on the executor follow the copy fee ladder, by your volume of the last 14 days: 2.5 bp under $100k, 2 bp from $100k, 1.5 bp from $500k, 1.2 bp from $2M, 1 bp from $10M. The approval you sign covers at most 0.025%.',
  },
  {
    q: 'What are algo orders and practice runs?',
    a: 'An algo order works one instruction into many orders over time - TWAP, chase, iceberg, scale, conditional, bracket and more - with an optional take-profit and stop-loss. A practice run uses the live order book and trades but sends nothing; it needs no wallet. A live run places real orders in your own SoDEX account, from this browser or from the executor.',
  },
  {
    q: 'How long do keys last?',
    a: 'The terminal\'s trading key in this browser lasts up to 7 days; then you enable trading again with one signature. Copy keys: 7 days for the browser mode; for the executor and self-hosted you choose 7, 30, 90 or 180 days.',
  },
  {
    q: 'How do I revoke a key?',
    a: 'Turn trading off (Settings - Security) to remove this browser\'s trading key. A copy key is deleted on the Copy page; that is the hard stop - it is revoked on SoDEX after the copies and algos using it are stopped. You can also delete any API key yourself on sodex.com.',
  },
  {
    q: 'How do I stop everything?',
    a: 'On the Copy page, Stop all stops every copy in every mode. In the Algos tab, Cancel all cancels every running algo order and pulls its take-profit and stop-loss. Stopping does not close your positions - use Stop and close, or close them yourself. Deleting the copy key is the hard stop.',
  },
  {
    q: 'Where can I use ValueDesk?',
    a: 'Not in sanctioned countries and regions (among them Cuba, Iran, North Korea, Syria, Russia, Belarus and Myanmar). In the United States, the United Kingdom and Canada it is close-only: you can reduce and close positions but not open new ones, and copy trading is not offered.',
  },
  {
    q: 'Where does ValueDesk run?',
    a: 'The website is delivered by Vercel. The data service (leaderboards, cohorts, news) runs on our server in France, the copy and algo executor on our server in Japan. Market data and your own account are read by your browser directly from SoDEX and Hyperliquid.',
  },
  {
    q: 'Is something down?',
    a: 'The status page shows whether the website, the data API, the copy and algo executor and the indexer are up right now, and their last 90 days.',
  },
  {
    q: 'What data does ValueDesk keep?',
    a: 'There are no accounts, no cookies of our own and no analytics. Crash reports are stripped of addresses, keys and anything you typed. Feedback is kept to answer you. The privacy policy has the details.',
  },
];

export function HelpSection({ close }: { close: () => void }) {
  return (
    <>
      <p className="stg__lede">Answers to what people ask most. Anything else - a bug, an idea, a question - send it to us; our reply appears in the bell.</p>
      <div className="stg__card stg__faqfeedback">
        <button
          type="button"
          className="stg__btn is-go"
          onClick={() => {
            close();
            openFeedback();
          }}
        >
          <FeedbackIcon /> Send feedback
        </button>
        <span className="stg__faqhint">Right-click anything in the app to send feedback about it.</span>
      </div>
      <div className="stg__card stg__faq">
        {FAQ.map((f) => (
          <details key={f.q} className="stg__faqitem">
            <summary>{f.q}</summary>
            <p>
              {f.a}
              {f.q === 'Is something down?' && <> <a href={STATUS_PATH} onClick={close}>Open the status page</a>.</>}
              {f.q === 'What data does ValueDesk keep?' && <> <LegalLink page="privacy">Privacy policy</LegalLink>.</>}
            </p>
          </details>
        ))}
      </div>
    </>
  );
}
