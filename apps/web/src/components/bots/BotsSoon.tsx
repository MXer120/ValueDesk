/**
 * Bots on the main site: in the navbar, and "coming soon" (owner, 2026-11-02: "I want the bots only on the beta
 * pages, not live. On live just in the navbar and coming soon"). The page itself (BotsPage) is built into the beta
 * channel only (App.tsx, VITE_CHANNEL=beta): nothing of it loads here.
 *
 * Drawn as the page's own first card (portfolio/parts Card), with the two strategies it will run.
 */
import { Card } from '../portfolio/parts';
import { BotIcon } from './BotIcon';
import { STRATEGIES, STRATEGY_INFO } from '../../bots/presets';
import './bots.css';

export function BotsSoon() {
  return (
    <div className="pf bots">
      <Card title="Bots" className="bots-soon" action={<span className="bots-soonpill">Coming soon</span>}>
        <div className="bots-soon__lead">
          <b>Automated strategies, run around the clock in your own SoDEX account</b>
          <span>Every order rests on the book: SoDEX's maker fee, never the spread. Bots are being tested on the beta now and come to ValueDesk next.</span>
        </div>
        <ul className="bots-soon__list">
          {STRATEGIES.map((s) => (
            <li key={s}>
              <BotIcon strategy={s} size={20} />
              <span>
                <b>{STRATEGY_INFO[s].name}</b>
                <small>{STRATEGY_INFO[s].line}</small>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
