/**
 * The bot's Watchdog (owner 2026-11-09): every part that keeps it running, as the executor checked it on this read -
 * its loop, the service, SoDEX's price, the oracle, its order updates, its holding against SoDEX, the trading key,
 * SoDEX's refusals in the last hour and whether it quotes. One line each with a dot, the state in the header. An
 * executor older than the Watchdog sends none: the card says so.
 */
import { marketLabel } from '../../bots/engines';
import type { AlgoView, BotHealthCheck } from '@copy-engine';
import { Panel, Shell, ShellHeader, StatusPill, type Tone } from './kit/kit';

const TONE: Record<BotHealthCheck['state'], Tone> = { ok: 'positive', warn: 'warning', bad: 'negative', off: 'neutral' };

/** The header's word for all the checks together. */
export function watchdogSummary(checks: readonly BotHealthCheck[]): { tone: Tone; text: string } {
  const bad = checks.filter((c) => c.state === 'bad').length;
  const warn = checks.filter((c) => c.state === 'warn').length;
  if (bad) return { tone: 'negative', text: bad === 1 ? '1 problem' : `${bad} problems` };
  if (warn) return { tone: 'warning', text: warn === 1 ? '1 to watch' : `${warn} to watch` };
  return { tone: 'positive', text: 'All healthy' };
}

export function Watchdog({ v }: { v: AlgoView }) {
  const h = v.bot?.health;
  const sum = h ? watchdogSummary(h.checks) : null;
  return (
    <Shell className="bots-sidecard is-plain bots-watchdog">
      <ShellHeader
        icon="pulse"
        title="Watchdog"
        subtitle="Everything that keeps this bot running, checked live"
        aside={sum ? <StatusPill size="sm" tone={sum.tone} dot pulse={sum.tone !== 'positive'}>{sum.text}</StatusPill> : undefined}
      />
      <Panel className="bots-sidepanel">
        {!h ? (
          <p className="bots-note">This server does not report its checks yet.</p>
        ) : (
          <ul className="bots-wd" aria-label="Health checks">
            {h.checks.map((c) => (
              <li key={c.id} className={`bots-wd__row is-${c.state}`}>
                <StatusPill size="sm" tone={TONE[c.state]} dot aria-label={c.state === 'ok' ? 'healthy' : c.state === 'warn' ? 'to watch' : c.state === 'bad' ? 'problem' : 'not used'}>{c.label}</StatusPill>
                <span className="bots-wd__v">{c.value}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Shell>
  );
}

/** The worst check of a bot (bad, then warn), for the fleet's line; null: all healthy. */
function worst(checks: readonly BotHealthCheck[]): BotHealthCheck | null {
  return checks.find((c) => c.state === 'bad') ?? checks.find((c) => c.state === 'warn') ?? null;
}

/**
 * The fleet's Watchdog on the Bots Overview: one line per bot that runs or is paused - its name, the state of all its
 * checks together, and what needs a look (the worst check). A line opens the bot, whose own card lists every check.
 */
export function FleetWatchdog({ bots, name, open }: { bots: readonly AlgoView[]; name: (v: AlgoView) => string; open: (id: string) => void }) {
  const live = bots.filter((v) => v.bot?.health && v.bot.health.checks.some((c) => c.id !== 'loop' || c.state !== 'off'));
  if (!live.length) return null;
  const all = live.flatMap((v) => v.bot!.health!.checks);
  const sum = watchdogSummary(all);
  // Bots with the same name (seven "live-test bot.makers") are told apart by their market.
  const seen = new Map<string, number>();
  for (const v of live) seen.set(name(v), (seen.get(name(v)) ?? 0) + 1);
  const label = (v: AlgoView) => ((seen.get(name(v)) ?? 0) > 1 ? `${name(v)} · ${marketLabel(v.algo.spec.symbol)}` : name(v));
  return (
    <Shell className="bots-watchdog is-fleet">
      <ShellHeader
        icon="pulse"
        title="Watchdog"
        subtitle={`${live.length} bot${live.length === 1 ? '' : 's'} checked live: loop, prices, order updates, holding, key, refusals`}
        aside={<StatusPill size="sm" tone={sum.tone} dot pulse={sum.tone !== 'positive'}>{sum.text}</StatusPill>}
      />
      <Panel className="bots-sidepanel">
        <ul className="bots-wd" aria-label="Bots' health">
          {live.map((v) => {
            const checks = v.bot!.health!.checks;
            const s = watchdogSummary(checks);
            const w = worst(checks);
            return (
              <li key={v.algo.id} className={`bots-wd__row is-${w?.state ?? 'ok'}`}>
                <button type="button" className="bots-wd__bot" onClick={() => open(v.algo.id)}>
                  <StatusPill size="sm" tone={s.tone} dot>{label(v)}</StatusPill>
                </button>
                <span className="bots-wd__v">{w ? `${w.label}: ${w.value}` : `${checks.filter((c) => c.state === 'ok').length} checks pass`}</span>
              </li>
            );
          })}
        </ul>
      </Panel>
    </Shell>
  );
}
