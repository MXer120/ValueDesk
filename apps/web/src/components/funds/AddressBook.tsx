/**
 * The address book: a drawer that slides out of the Withdraw sheet's right edge
 * (Modal `aside`), as tall as the sheet - the sheet itself does not change, the
 * pair just re-centres.
 *
 *   ‹  Address book                  ‹ folds it back in
 *   [ search name or address ]
 *   View all                         every contact A-Z, one heading per letter
 *   FAVORITES   [Bitget·Ξ] Bitget ETH   0x12…ab   ☆
 *   RECENT      [USDC·◆]  usdc arb     0x34…cd   ✎ ×   × (on hover) takes it out of Recent
 *   + Add contact
 *
 * Each contact is drawn as its platform's logo (or its coin's) with the CHAIN
 * as the small badge - worked out from its name and address
 * (addrbook/detect.ts), changeable in the contact's form. XRP / Stellar
 * contacts keep their memo (the tag an exchange credits by). Only contacts the
 * chosen chain can pay are listed.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Collapse, FadeView } from '../motion';
import { ADDRESS_KIND_LABEL } from '../../trading/addresses';
import {
  addressKind,
  clearRecent,
  contactProblem,
  groupByLetter,
  recentContacts,
  removeContact,
  saveContact,
  sortContacts,
  toggleFavorite,
  updateContact,
  useContacts,
  type Contact,
  type ContactKind,
  type ContactLook,
} from './contacts';
import { CATALOG } from './addrbook/catalogData';
import { ContactAvatar, KNOWN_COINS, catalogChainLogo, chainById, platformById, platformLogo, useContactLook } from './addrbook/ContactAvatar';
import { chainsForKind, detectFromName, resolveLook } from './addrbook/detect';
import { FxSelect, SearchIcon, short, type FxOption } from './ui';

type Row = 'favorite' | 'recent' | 'all';
const MEMO_KINDS = new Set<ContactKind>(['xrp', 'stellar']);
const KIND_LABEL: Record<string, string> = { cex: 'Exchange', dex: 'DEX', wallet: 'Wallet', defi: 'DeFi', bridge: 'Bridge' };

export function AddressBook({ kind, onPick, onClose, draft }: {
  kind: ContactKind;
  onPick: (contact: Contact) => void;
  onClose: () => void;
  /** An address typed in the form and not saved yet: opens the add form with it. */
  draft?: string;
}) {
  const contacts = useContacts();
  const [query, setQuery] = useState('');
  const [viewAll, setViewAll] = useState(false);
  /** The form: a new contact, or the one being edited. */
  const [form, setForm] = useState<{ id: string | null } | null>(draft ? { id: null } : null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const mine = useMemo(() => contacts.filter((c) => c.kind === kind), [contacts, kind]);
  const favorites = useMemo(() => sortContacts(mine.filter((c) => c.favorite), 'name'), [mine]);
  const recent = useMemo(() => recentContacts(mine), [mine]);
  const groups = useMemo(() => groupByLetter(mine), [mine]);
  const results = useMemo(
    () => (q ? sortContacts(mine.filter((c) => c.name.toLowerCase().includes(q) || c.address.toLowerCase().includes(q)), 'name') : []),
    [mine, q],
  );
  const editing = form?.id ? contacts.find((c) => c.id === form.id) ?? null : null;

  const row = (c: Contact, as: Row) => (
    <li key={c.id} className="fx-book__row">
      {confirmDelete === c.id ? (
        <div className="fx-book__confirm">
          <span>Delete {c.name}?</span>
          <button type="button" className="fx-chip fx-chip--danger" onClick={() => { removeContact(c.id); setConfirmDelete(null); }}>Delete</button>
          <button type="button" className="fx-chip" onClick={() => setConfirmDelete(null)}>Keep</button>
        </div>
      ) : (
        <>
          <button type="button" className="fx-book__pick" onClick={() => onPick(c)} title={c.address}>
            <RowAvatar c={c} />
            <span className="fx-book__pick-t">
              <b>{c.name}</b>
              <small>{short(c.address)}{c.memo ? ` · memo ${c.memo}` : ''}</small>
            </span>
          </button>
          <span className="fx-book__acts">
            <button type="button" className="fx-iconbtn" aria-label={`Edit ${c.name}`} title="Edit" onClick={() => setForm({ id: c.id })}>
              <PencilIcon />
            </button>
            {as === 'recent' && (
              <button type="button" className="fx-iconbtn" aria-label={`Remove ${c.name} from recent`} title="Remove from recent" onClick={() => clearRecent([c.id])}>
                <CrossIcon />
              </button>
            )}
            {as === 'all' && (
              <button type="button" className="fx-iconbtn" aria-label={`Delete ${c.name}`} title="Delete" onClick={() => setConfirmDelete(c.id)}>
                <TrashIcon />
              </button>
            )}
          </span>
          <button
            type="button"
            className={`fx-book__star${c.favorite ? ' is-on' : ''}`}
            aria-pressed={!!c.favorite}
            aria-label={c.favorite ? `Unstar ${c.name}` : `Star ${c.name}`}
            title={c.favorite ? 'Remove from favorites' : 'Add to favorites'}
            onClick={() => toggleFavorite(c.id)}
          >
            <StarIcon filled={!!c.favorite} />
          </button>
        </>
      )}
    </li>
  );

  const none = `No saved ${ADDRESS_KIND_LABEL[kind]} addresses yet.`;
  let body: ReactNode;
  if (q) {
    body = results.length ? <ul className="fx-book__list">{results.map((c) => row(c, 'all'))}</ul> : <p className="fx-note">No contact matches.</p>;
  } else if (viewAll) {
    body = groups.length ? (
      groups.map((g) => (
        <section key={g.letter} aria-label={g.letter}>
          <p className="fx-book__sec fx-book__letter">{g.letter}</p>
          <ul className="fx-book__list">{g.contacts.map((c) => row(c, 'all'))}</ul>
        </section>
      ))
    ) : (
      <p className="fx-note">{none}</p>
    );
  } else {
    body = (
      <>
        {favorites.length > 0 && (
          <section>
            <p className="fx-book__sec">Favorites</p>
            <ul className="fx-book__list">{favorites.map((c) => row(c, 'favorite'))}</ul>
          </section>
        )}
        {recent.length > 0 && (
          <section className="fx-book__recent">
            <p className="fx-book__sec">
              Recent
              <button type="button" className="fx-book__clear" onClick={() => clearRecent(recent.map((c) => c.id))} title="Clear recent">
                Clear
              </button>
            </p>
            <ul className="fx-book__list">{recent.map((c) => row(c, 'recent'))}</ul>
          </section>
        )}
        {favorites.length + recent.length === 0 && (
          <p className="fx-note">{mine.length ? 'Nothing recent - View all lists every contact.' : none}</p>
        )}
      </>
    );
  }

  return (
    <div className="fx-book">
      <div className="fx-book__head">
        <button type="button" className="fx-iconbtn fx-book__fold" onClick={onClose} aria-label="Fold the address book away" title="Collapse">
          <FoldIcon />
        </button>
        <h3>Address book</h3>
      </div>
      <div className="fx-search fx-book__search">
        <SearchIcon />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or address" aria-label="Search contacts" spellCheck={false} />
      </div>
      {!q && (
        <button type="button" className="fx-link fx-book__viewall" aria-pressed={viewAll} onClick={() => setViewAll((v) => !v)}>
          {viewAll ? '‹ Favorites and recent' : `View all${mine.length ? ` (${mine.length})` : ''}`}
        </button>
      )}

      <div className="fx-book__scroll">
        <FadeView viewKey={q ? 'search' : viewAll ? 'all' : 'main'} className="fx-book__view">
          {body}
        </FadeView>
      </div>

      <div className="fx-book__foot">
        <Collapse open={!!form}>
          {form && (
            <ContactForm
              key={form.id ?? `new:${draft ?? ''}`}
              editing={editing}
              draft={form.id ? undefined : draft}
              onDone={(c) => {
                setForm(null);
                if (c && !editing && draft && c.address === draft.trim()) onPick(c);
              }}
            />
          )}
        </Collapse>
        {!form && (
          <button type="button" className="fx-cta fx-cta--ghost" onClick={() => setForm({ id: null })}>+ Add contact</button>
        )}
      </div>
    </div>
  );
}

function RowAvatar({ c }: { c: Contact }) {
  const look = useContactLook(c);
  return <ContactAvatar name={c.name} kind={c.kind} look={look} size={30} />;
}

/** "auto" | "none" | "p:<platform>" | "c:<coin>" */
type LogoPick = string;
const logoPickOf = (look: ContactLook | undefined): LogoPick =>
  look?.platform ? `p:${look.platform}` : look?.coin ? `c:${look.coin}` : look?.platform === null && look?.coin === null ? 'none' : 'auto';
const lookOf = (logo: LogoPick, chain: string): ContactLook => ({
  ...(logo === 'auto' ? {} : logo === 'none' ? { platform: null, coin: null } : logo.startsWith('p:') ? { platform: logo.slice(2), coin: null } : { platform: null, coin: logo.slice(2) }),
  ...(chain === 'auto' ? {} : { chain }),
});

/** Every logo a contact can have: platforms by kind, then coins. Built once. */
let LOGO_OPTIONS: FxOption[] | null = null;
const logoOptions = (): FxOption[] =>
  (LOGO_OPTIONS ??= [
    ...CATALOG.platforms.map((p) => ({
      value: `p:${p.id}`,
      label: p.name,
      iconNode: <LogoImg src={platformLogo(p.id)} letter={p.name} />,
      hint: KIND_LABEL[p.kind] ?? p.kind,
    })),
    ...[...KNOWN_COINS].sort().map((coin) => ({ value: `c:${coin}`, label: coin, icon: coin, hint: 'Coin' })),
  ]);

function LogoImg({ src, letter }: { src: string | null; letter: string }) {
  const [bad, setBad] = useState(false);
  return src && !bad ? <img className="fx-av ab-optimg" src={src} alt="" width={20} height={20} onError={() => setBad(true)} /> : <span className="fx-av ab-optletter">{letter.charAt(0).toUpperCase()}</span>;
}

/** Add a contact, or edit one: name, address (fixed when editing), memo, logo, chain - with a live preview. */
function ContactForm({ editing, draft, onDone }: { editing: Contact | null; draft?: string; onDone: (c: Contact | null) => void }) {
  const [name, setName] = useState(editing?.name ?? '');
  const [addr, setAddr] = useState(editing?.address ?? draft ?? '');
  const [memo, setMemo] = useState(editing?.memo ?? '');
  const [logo, setLogo] = useState<LogoPick>(logoPickOf(editing?.look));
  const [chain, setChain] = useState<string>(editing?.look?.chain ?? 'auto');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [name, addr, memo]);

  const kind = editing?.kind ?? addressKind(addr) ?? null;
  // Until there is an address every chain can be picked; an address narrows it
  // to the chains it can be on.
  const chains = kind ? chainsForKind(kind, CATALOG) : CATALOG.chains;
  const picked = chain === 'auto' ? null : chainById(chain);
  const chainMismatch = kind && picked && !chains.some((c) => c.id === picked.id) ? `A ${ADDRESS_KIND_LABEL[kind]} address cannot be on ${picked.name}.` : null;
  /** How to draw it before there is an address: as the picked chain's kind. */
  const drawKind = kind ?? (picked && picked.addressKind !== 'other' ? picked.addressKind : 'evm');
  const look = lookOf(logo, chain);
  const preview = resolveLook({ name: name || '?', kind: drawKind, look }, CATALOG, KNOWN_COINS);
  const auto = resolveLook({ name: name || '?', kind: drawKind }, CATALOG, KNOWN_COINS);
  const named = detectFromName(name, CATALOG, KNOWN_COINS);
  const autoLogo = platformById(auto.platform)?.name ?? auto.coin ?? 'none';
  const autoChain = chainById(kind ? auto.chain : named.chain)?.name ?? (kind === 'evm' ? 'any EVM chain' : kind ? '-' : 'from the address');
  const memoOn = !!kind && MEMO_KINDS.has(kind);
  const problem = (editing ? (name.trim() ? null : 'Give the contact a name.') : contactProblem(name, addr)) ?? chainMismatch;
  const memoBad = memoOn && memo.trim() && !/^\d{1,20}$/.test(memo.trim()) ? 'The memo is a number (digits only).' : null;

  const submit = () => {
    try {
      const m = memoOn ? memo : '';
      if (editing) {
        updateContact(editing.id, { name, look, memo: m });
        onDone(null);
      } else {
        onDone(saveContact(name, addr, { look, memo: m }));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <form
      className="fx-book__new"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="fx-book__sec">{editing ? `Edit ${editing.name}` : 'New contact'}</p>
      <div className="fx-book__namerow">
        <ContactAvatar name={name || '?'} kind={drawKind} look={preview} size={34} />
        <input className="fx-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Bitget ETH deposit" aria-label="Contact name" autoFocus={!!editing} />
      </div>
      {editing ? (
        <p className="fx-book__addr" title={editing.address}>{short(editing.address)} · {ADDRESS_KIND_LABEL[editing.kind]}</p>
      ) : (
        <input className="fx-input" value={addr} onChange={(e) => setAddr(e.target.value.trim())} placeholder="Address (0x…, bc1…, r…, T…)" aria-label="Contact address" spellCheck={false} />
      )}
      {memoOn && (
        <input className="fx-input" value={memo} onChange={(e) => setMemo(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="Memo / tag (if the exchange gave you one)" aria-label="Memo" />
      )}
      <div className="fx-book__picks">
        <FxSelect
          label="Logo"
          value={logo}
          onChange={setLogo}
          searchable
          searchPlaceholder="Exchange, wallet or coin"
          listMinWidth={260}
          listAlign="end"
          options={[{ value: 'auto', label: `Auto · ${autoLogo}` }, { value: 'none', label: 'No logo' }, ...logoOptions()]}
        />
        <FxSelect
          label="Chain"
          value={chain}
          onChange={setChain}
          searchable
          searchPlaceholder="Search chain"
          listMinWidth={220}
          listAlign="end"
          options={[
            { value: 'auto', label: `Auto · ${autoChain}` },
            ...chains.map((c) => ({ value: c.id, label: c.name, iconNode: <LogoImg src={catalogChainLogo(c)} letter={c.name} /> })),
          ]}
        />
      </div>
      {(error || memoBad || (problem && (name || addr))) && <p className="fx-note fx-note--err">{error ?? memoBad ?? problem}</p>}
      <div className="fx-book__actions">
        <button type="button" className="fx-cta fx-cta--ghost" onClick={() => onDone(null)}>Cancel</button>
        <button type="submit" className="fx-cta" disabled={!!problem || !!memoBad}>Save</button>
      </div>
    </form>
  );
}

export const BookIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 2.5h7.5c.6 0 1 .4 1 1v9c0 .6-.4 1-1 1H4a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 4 2.5Z" />
    <path d="M8 7.3a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8ZM5.6 10.6c.3-1.1 1.3-1.8 2.4-1.8s2.1.7 2.4 1.8M2.5 5.5h1.3M2.5 8h1.3M2.5 10.5h1.3" />
  </svg>
);
/** Fold the drawer back into the sheet (it slides out to the right). */
const FoldIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const CrossIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
const StarIcon = ({ filled }: { filled: boolean }) => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path
      d="m8 2.2 1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 11l-3.5 1.9.8-3.9-2.9-2.7 3.9-.5L8 2.2Z"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
);
const PencilIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m10.5 2.8 2.7 2.7L6 12.7l-3.3.6.6-3.3 7.2-7.2Z" />
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 4.5h11M6.5 4.5V3c0-.3.2-.5.5-.5h2c.3 0 .5.2.5.5v1.5M4 4.5l.6 8.3c0 .4.4.7.8.7h5.2c.4 0 .8-.3.8-.7l.6-8.3" />
  </svg>
);
