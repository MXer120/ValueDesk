/**
 * Scan's start and its wallet header, from the Profile version (owner 2026-11-28: "scan page start, use profile
 * versions search thing, just without the box & green light. Below recent searches & Alias/saved/... right of it. It
 * also needs to be possible to group them in tracked lists. From profile versions also use the platform switch, we
 * also need a big copy and countertrade button like in profile.").
 *
 * - ScanStart: the venues' marks, the title, the Profile search (address, saved name, Me), then two panels side by
 *   side: Recent searches, and Saved (the wallets named in this browser, and each tracked list as a tab of its own).
 * - ScanWho: who (avatar, name with copy and rename, where it is active, the venue's tags), Track (into any list), the
 *   big Copy trader and Counter-trade buttons, and the platform switch with each venue's balance.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, EmptyState, Icon, IconButton, Panel, Shell, ShellHeader, StatusPill, Tabs, TextInput } from '../bots/kit/kit';
import { VenueLogo } from '../VenueLogo';
import { fmtAgo } from '../copy/TraderCard';
import { useAddressMask } from '../../privacy';
import { shortAddr } from '../../format';
import { aliasFor } from '../../dashboard/scanAliases';
import { SCAN_VENUES, VENUE_LABEL, type TraderProfile, type Venue } from '../../vsApi';
import type { VenueCard } from './addressVenues';
import { standingOf } from './versions/model';
import { Avatar, CopyActions, ScanSearch, TraderTags, VenueSwitch, WalletName, savedWallets } from './versions/parts';
import { createList, deleteList, forgetRecent, listsOf, renameList, toggleInList, useScanMemory } from './tracked';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
const VENUES_TEXT = SCAN_VENUES.map((v) => VENUE_LABEL[v]).join(', ').replace(/, ([^,]*)$/, ' and $1');

/* ------------------------------------------------------------------ start ----- */

function WalletRow({ address, onOpen, aside, venue, when }: { address: string; onOpen: () => void; aside?: ReactNode; venue?: Venue; when?: number }) {
  const mask = useAddressMask();
  const name = aliasFor(address);
  return (
    <li className="sxs-row">
      <button type="button" className="sxs-row__go" onClick={onOpen} title={mask(address)}>
        <Avatar address={address} size={30} />
        <span className="sxs-row__t">
          <b>{name || mask(shortAddr(address))}</b>
          <small>{name ? mask(shortAddr(address)) : venue ? VENUE_LABEL[venue] : ''}{name && venue ? ` · ${VENUE_LABEL[venue]}` : ''}</small>
        </span>
        {venue && <VenueLogo venue={venue} size={16} />}
        {when !== undefined && <small className="sxs-row__when">{fmtAgo(when)}</small>}
      </button>
      {aside}
    </li>
  );
}

function NewList({ onDone, first }: { onDone: (id: string | null) => void; first?: string }) {
  const [name, setName] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); onDone(createList(name, first)); };
  return (
    <form className="sxs-newlist" onSubmit={submit}>
      <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="List name, e.g. Whales" aria-label="List name" maxLength={32} autoFocus />
      <Button type="submit" variant="primary">Create</Button>
      <Button variant="quiet" onClick={() => onDone(null)}>Cancel</Button>
    </form>
  );
}

export function ScanStart({ seed, busy, error, connected, onSearch, children }: {
  seed: string;
  busy: boolean;
  error: string | null;
  connected: string | null;
  onSearch: (input: string) => void;
  /** The venues of a wallet that has no active account anywhere (each opens its page). */
  children?: ReactNode;
}) {
  const mem = useScanMemory();
  const [tab, setTab] = useState<string>('named');
  const [making, setMaking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  // Names are kept by the wallet header (WalletName); re-read when the page is shown again.
  const [named, setNamed] = useState(savedWallets);
  useEffect(() => {
    const again = () => setNamed(savedWallets());
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, []);
  const list = mem.lists.find((l) => l.id === tab) ?? null;
  useEffect(() => { if (tab !== 'named' && !list) setTab('named'); }, [tab, list]);
  const tabs = [{ value: 'named', label: 'Named', count: named.length }, ...mem.lists.map((l) => ({ value: l.id, label: l.name, count: l.wallets.length }))];

  return (
    <div className="sxs">
      <section className="sxs-hero">
        <span className="sxs-marks" aria-hidden="true">{SCAN_VENUES.map((v) => <span key={v}><VenueLogo venue={v} size={30} /></span>)}</span>
        <h1>Look up any wallet</h1>
        <p>Its PnL, positions and history on {VENUES_TEXT}.</p>
        <ScanSearch seed={seed} connected={connected} onSearch={onSearch} error={error} size="md" className="sxs-find" />
        {busy && <StatusPill size="sm" dot pulse>Checking {SCAN_VENUES.length} venues</StatusPill>}
        {children && <div className="sxs-cards">{children}</div>}
      </section>

      <div className="sxs-cols">
        <Shell className="sxs-panel">
          <ShellHeader title="Recent searches" aside={mem.recent.length > 0 ? <Button variant="quiet" onClick={() => forgetRecent()}>Clear</Button> : undefined} />
          <Panel className="sxs-body">
            {mem.recent.length === 0
              ? <EmptyState compact icon="search" title="Nothing searched yet" description="The wallets you open show here." />
              : (
                <ul className="sxs-list">
                  {mem.recent.map((r) => (
                    <WalletRow key={r.address} address={r.address} venue={r.venue} when={r.at} onOpen={() => onSearch(r.address)}
                      aside={<IconButton icon="x" label="Remove from recent searches" className="sxs-row__x" onClick={() => forgetRecent(r.address)} />} />
                  ))}
                </ul>
              )}
          </Panel>
        </Shell>

        <Shell className="sxs-panel">
          <ShellHeader title="Saved" subtitle="Named wallets and your tracked lists" aside={!making ? <Button variant="secondary" icon="plus" onClick={() => setMaking(true)}>New list</Button> : undefined} />
          {making && <NewList onDone={(id) => { setMaking(false); if (id) setTab(id); }} />}
          <div className="sxs-tabs"><Tabs tabs={tabs} value={tab} onChange={(v) => { setTab(v); setRenaming(false); }} label="Saved wallets" /></div>
          <Panel className="sxs-body">
            {list && (
              <div className="sxs-listbar">
                {renaming ? (
                  <form className="sxs-newlist" onSubmit={(e) => { e.preventDefault(); renameList(list.id, draft); setRenaming(false); }}>
                    <TextInput value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="List name" maxLength={32} autoFocus />
                    <Button type="submit" variant="primary">Save</Button>
                    <Button variant="quiet" onClick={() => setRenaming(false)}>Cancel</Button>
                  </form>
                ) : (
                  <>
                    <small>{list.wallets.length === 1 ? '1 wallet' : `${list.wallets.length} wallets`} · add one with Track on its page</small>
                    <span>
                      <Button variant="quiet" icon="pen" onClick={() => { setDraft(list.name); setRenaming(true); }}>Rename</Button>
                      <Button variant="quiet" icon="trash" onClick={() => deleteList(list.id)}>Delete list</Button>
                    </span>
                  </>
                )}
              </div>
            )}
            {(list ? list.wallets : named.map((n) => n.address)).length === 0 ? (
              <EmptyState compact icon={list ? 'list' : 'pen'} title={list ? 'This list is empty' : 'No named wallets'} description={list ? 'Open a wallet and press Track to add it here.' : 'Name a wallet on its page (the pen beside its address); it shows here.'} />
            ) : (
              <ul className="sxs-list">
                {(list ? list.wallets : named.map((n) => n.address)).map((a) => (
                  <WalletRow key={a} address={a} onOpen={() => onSearch(a)}
                    aside={list ? <IconButton icon="x" label={`Remove from ${list.name}`} className="sxs-row__x" onClick={() => toggleInList(list.id, a)} /> : undefined} />
                ))}
              </ul>
            )}
          </Panel>
        </Shell>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- header ----- */

/** Track: put the wallet into any of the lists (or a new one). */
function TrackMenu({ address }: { address: string }) {
  const mem = useScanMemory();
  const [open, setOpen] = useState(false);
  const [making, setMaking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const inLists = listsOf(mem, address);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) { setOpen(false); setMaking(false); } };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setMaking(false); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  return (
    <div className="sxh-track" ref={box}>
      <Button variant="secondary" size="md" icon="star" aria-expanded={open} onClick={() => setOpen(!open)} className={cx(inLists.length > 0 && 'is-tracked')}>
        {inLists.length ? (inLists.length === 1 ? inLists[0]!.name : `${inLists.length} lists`) : 'Track'}
      </Button>
      {open && (
        <div className="sxh-track__pop tf" role="dialog" aria-label="Tracked lists">
          {mem.lists.length === 0 && !making && <p className="sxh-track__none">Group wallets in lists of your own, like Whales or To copy.</p>}
          {mem.lists.length > 0 && (
            <ul>
              {mem.lists.map((l) => {
                const on = l.wallets.some((w) => w === address.toLowerCase());
                return (
                  <li key={l.id}>
                    <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => toggleInList(l.id, address)}>
                      <span className={cx('sxh-track__box', on && 'is-on')} aria-hidden="true">{on && <Icon name="check" size={12} />}</span>
                      <span>{l.name}</span>
                      <small>{l.wallets.length}</small>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {making ? <NewList first={address} onDone={() => setMaking(false)} /> : <Button variant="quiet" icon="plus" onClick={() => setMaking(true)}>New list</Button>}
        </div>
      )}
    </div>
  );
}

export function ScanWho({ address, venue, profile, cards, onVenue, settled }: {
  address: string;
  venue: Venue;
  profile: TraderProfile | null;
  cards: VenueCard[];
  onVenue: (v: Venue) => void;
  settled: boolean;
}) {
  const active = useMemo(() => cards.filter((c) => standingOf(c) === 'active').length, [cards]);
  return (
    <section className="sxh">
      <div className="sxh__who">
        <Avatar address={address} size={52} />
        <div className="sxh__id">
          <WalletName address={address} />
          <div className="sxh__meta">
            {!settled ? <StatusPill size="sm" dot pulse>Checking {SCAN_VENUES.length} venues</StatusPill>
              : <StatusPill size="sm" tone={active ? 'positive' : 'neutral'} dot={active > 0}>{active ? `Active on ${active} of ${SCAN_VENUES.length} venues` : 'No active venue'}</StatusPill>}
            <TraderTags p={profile} />
          </div>
        </div>
        <div className="sxh__acts">
          <TrackMenu address={address} />
          <CopyActions address={address} venue={venue} profile={profile} size="lg" className="sxh__copy" />
        </div>
      </div>
      <VenueSwitch cards={cards} value={venue} onPick={onVenue} equity className="sxh__venues" />
    </section>
  );
}
