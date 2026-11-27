/**
 * Scan's four keys, where the Portfolio has Deposit, Withdraw, Transfer and Swap (owner 2026-11-27: Scan in the
 * Portfolio's layout): Copy (the main one), Counter, Name and Address. Copy and Counter open the copy setup for this
 * wallet (the Copy page's own link, so inside the Copy page's trader window the setup opens over it); a venue a copy
 * cannot follow keeps them, disabled, with the reason. Name keeps a name for the address in this browser (the same
 * names Scan's search takes); Address copies it.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Icon, TextInput } from '../bots/kit/kit';
import { CopyGlyph, CounterGlyph } from '../copy/TraderCard';
import { isCopyable } from '../copy/gridModel';
import { VENUE_LABEL, type Venue } from '../../vsApi';
import { openPath } from '../../nav';
import { aliasFor, saveAlias } from '../../dashboard/scanAliases';

const CopyAddressIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><rect x="7" y="7" width="9.5" height="9.5" rx="2" /><path d="M13 7V5.5A2 2 0 0 0 11 3.5H5.5a2 2 0 0 0-2 2V11a2 2 0 0 0 2 2H7" /></svg>
);

export function ScanKeys({ address, venue }: { address: string; venue: Venue }) {
  const [copied, setCopied] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(() => aliasFor(address));
  const [draft, setDraft] = useState(name);
  useEffect(() => { const n = aliasFor(address); setName(n); setDraft(n); setNaming(false); }, [address]);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);
  const copyable = isCopyable(venue);
  const why = copyable ? undefined : `Copying ${VENUE_LABEL[venue]} traders is not supported yet`;
  const setup = (direction: 'copy' | 'counter') => openPath(`/copy?address=${encodeURIComponent(address)}&venue=${venue}&direction=${direction}`);
  const key = (label: string, icon: ReactNode, on: () => void, o: { main?: boolean; off?: boolean; title?: string } = {}) => (
    <button type="button" className={`pfv-key${o.main ? ' is-main' : ''}`} onClick={on} disabled={o.off} title={o.title}>
      <span className="pfv-key__c" aria-hidden="true">{icon}</span>
      <span className="pfv-key__t">{label}</span>
    </button>
  );
  const save = (e: FormEvent) => {
    e.preventDefault();
    saveAlias(address, draft);
    setName(draft.trim());
    setNaming(false);
  };
  return (
    <>
      <div className="pfv-keys">
        {key('Copy', <CopyGlyph />, () => setup('copy'), { main: true, off: !copyable, title: why ?? 'Copy this trader’s trades' })}
        {key('Counter', <CounterGlyph />, () => setup('counter'), { off: !copyable, title: why ?? 'Take the other side of every trade' })}
        {key(name || 'Name', <Icon name="pen" size={18} />, () => setNaming(!naming), { title: name ? `Named “${name}” in this browser` : 'Name this address in this browser' })}
        {key(copied ? 'Copied' : 'Address', copied ? <Icon name="check" size={18} /> : <CopyAddressIcon />, () => { void navigator.clipboard?.writeText(address).then(() => setCopied(true), () => {}); }, { title: address })}
      </div>
      {naming && (
        <form className="pfv-name tf" onSubmit={save}>
          <TextInput value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="A name for this address" aria-label="Name" maxLength={40} autoFocus />
          <Button type="submit" variant="primary">Save</Button>
          <Button variant="quiet" onClick={() => { setDraft(name); setNaming(false); }}>Cancel</Button>
        </form>
      )}
    </>
  );
}
