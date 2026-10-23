/**
 * Mounted once in App.tsx, on every page: keeps live copying following the
 * connected wallet (so the browser copier runs whichever page is open), and
 * shows the "copy this trade?" prompts of copies set to ask each time.
 * Loaded after the page itself (App.tsx lazy-loads it).
 */
import { useEffect, useState } from 'react';
import { fmtUsd, shortAddr } from '../format';
import type { Eip1193Provider } from '../wallet';
import { answerConfirm, useLiveCopy } from './live';
import './copy.css';

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="muted">{Math.max(0, Math.round((until - now) / 1000))}s</span>;
}

export default function CopyRunner({ address, provider }: { address: string | null; provider: Eip1193Provider | null }) {
  const live = useLiveCopy(address, provider);
  const confirms = live.browser.confirms;
  if (!confirms.length) return null;
  return (
    <div className="copy-prompts" role="region" aria-label="Copied trades waiting for you">
      {confirms.map((q) => (
        <div key={q.id} className="copy-prompt" role="alertdialog" aria-label="Copy this trade?">
          <div className="copy-prompt__head">
            <b>Copy this trade?</b> <Countdown until={q.expiresAt} />
          </div>
          <p className="copy-prompt__what">
            {shortAddr(q.sub.settings.leader.address)} moved {q.event.symbol} from {q.event.before ?? 0} to {q.event.after}.
          </p>
          <ul className="copy-prompt__orders">
            {q.intents.map((i) => (
              <li key={i.clOrdID}>
                {i.side === 'buy' ? 'Buy' : 'Sell'} {i.quantity} {i.symbol} up to {i.limitPrice} ({fmtUsd(i.notionalUsd, 2)}){i.reduceOnly ? ', reduce-only' : ''}
              </li>
            ))}
          </ul>
          <div className="copy-prompt__acts">
            <button type="button" className="pf-btn" onClick={() => answerConfirm(q.id, false)}>Skip</button>
            <button type="button" className="pf-btn pf-btn--primary" onClick={() => answerConfirm(q.id, true)}>Copy it</button>
          </div>
        </div>
      ))}
    </div>
  );
}
