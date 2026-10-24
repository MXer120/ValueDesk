/**
 * Picking one of the wallet's items, to show it as a card - in a doc (an
 * itemRef node) or on a board (an item element). Searches every folder.
 */
import { useEffect, useState } from 'react';
import { useFolders } from '../folders/state';
import { KindIcon, KIND_LABEL } from './views';

export function CardPicker({ exclude, onPick, onClose }: { exclude?: string; onPick: (id: string) => void; onClose: () => void }) {
  const s = useFolders();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="kd-picker" role="dialog" aria-label="Insert a card of an item">
      <div className="kd-picker__panel">
        <header>
          <b>Insert a card</b>
          <button type="button" className="kf__iconbtn" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </header>
        <input className="fx-input" autoFocus placeholder="Search your folders" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="kd-picker__list">
          {(s.list?.folders ?? []).map((f) => {
            const items = f.items.filter((i) => i.id !== exclude && (!needle || i.title.toLowerCase().includes(needle)));
            if (!items.length) return null;
            return (
              <div key={f.id}>
                <span className="kd-picker__folder">{f.name}</span>
                {items.map((i) => (
                  <button key={i.id} type="button" className="kd-picker__item" onClick={() => onPick(i.id)}>
                    <KindIcon item={i} size={13} />
                    <span>{i.title}</span>
                    <small>{KIND_LABEL[i.kind]}</small>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
