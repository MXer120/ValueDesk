/**
 * The leaderboard in versions, on localhost only (owner 2026-11-26: "localhost only with multiple versions and the
 * switch ... Do not delete the original keep it in the switch"). A pill at the bottom switches between them and is
 * remembered in this browser; a build never loads this file and shows the Original (LeaderboardPage.tsx).
 *
 * Every version reads the same board the same way (useBoard.ts) and shows only its figures.
 */
import { useState, type ReactNode } from 'react';
import { Desk } from './Desk';
import { Stage } from './Stage';
import { MapView } from './Map';
import type { VersionProps } from './types';
import '../../bots/kit/kit.css';
import '../../Account.css';
import './versions.css';
import './stage.css';
import './map.css';

const KEY = 'vs.dev.leaderboard.version';
const VERSIONS = [
  { id: 'original', name: 'Original' },
  { id: 'desk', name: 'Desk' },
  { id: 'stage', name: 'Stage' },
  { id: 'map', name: 'Map' },
] as const;
type Id = (typeof VERSIONS)[number]['id'];

function stored(): Id {
  try {
    const v = localStorage.getItem(KEY);
    return VERSIONS.some((x) => x.id === v) ? (v as Id) : 'original';
  } catch {
    return 'original';
  }
}

export function LeaderboardVersions({ original, ...props }: VersionProps & { original: ReactNode }) {
  const [id, setId] = useState<Id>(stored);
  const pick = (v: Id) => {
    setId(v);
    try { localStorage.setItem(KEY, v); } catch { /* this tab only */ }
    if (!props.embedded) (document.querySelector('.appcontent') ?? document.scrollingElement)?.scrollTo({ top: 0 });
  };
  const body = id === 'desk' ? <Desk {...props} /> : id === 'stage' ? <Stage {...props} /> : id === 'map' ? <MapView {...props} /> : original;
  return (
    <>
      {body}
      {!props.embedded && (
        <nav className="lbv-switch" aria-label="Leaderboard versions" data-no-i18n="">
          {VERSIONS.map((x, i) => (
            <button key={x.id} type="button" aria-pressed={id === x.id} className={id === x.id ? 'is-on' : ''} onClick={() => pick(x.id)}>
              <b>{i + 1}</b><span>{x.name}</span>
            </button>
          ))}
        </nav>
      )}
    </>
  );
}
