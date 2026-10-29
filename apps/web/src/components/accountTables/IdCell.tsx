/**
 * The "IDs" column of the account tables (and the Algos tab): each id short,
 * a click copies it whole, and "Copy details" copies the support-ticket block
 * (ids.ts supportText). Off by default; switched on in the band's View pop-up,
 * one setting for every table, remembered across reloads.
 */
import { useSharedStored } from '../../hooks';
import { DASH } from '../../format';
import { notify } from '../../toast';
import { IDS_KEY, idText, shortId } from './ids';

/** Whether the tables show their IDs column. Live across every mounted table. */
export function useShowIds(): [boolean, (v: boolean) => void] {
  const [on, set] = useSharedStored<boolean>(IDS_KEY, false);
  return [on === true, set];
}

/**
 * Puts `text` on the clipboard and says so. Where the Clipboard API is refused
 * (no permission, an insecure origin, an embedded browser) the old selection
 * copy is tried; a browser that refuses both is said too.
 */
export function copyText(text: string, done: string): void {
  const fallback = () => {
    if (legacyCopy(text)) notify('ok', done);
    else notify('warn', "Couldn't copy: the browser blocked the clipboard.");
  };
  if (!navigator.clipboard?.writeText) return fallback();
  navigator.clipboard.writeText(text).then(() => notify('ok', done), fallback);
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  const back = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  back?.focus?.({ preventScroll: true });
  return ok;
}

/** One id: its label, its last 8 characters, a copy glyph. Nothing when there is no id. */
export function IdChip({ label, what, id }: { label: string; /** "Order ID" - the toast and the tooltip. */ what: string; id: unknown }) {
  const full = idText(id);
  if (!full) return null;
  return (
    <button
      type="button"
      className="acct-id"
      title={`${what}: ${full} (click to copy)`}
      aria-label={`Copy ${what} ${full}`}
      onClick={(e) => { e.stopPropagation(); copyText(full, `${what} copied`); }}
    >
      <span className="acct-id__k">{label}</span>
      <span className="acct-id__v">{shortId(full)}</span>
      <CopyIcon />
    </button>
  );
}

export type IdEntry = readonly [label: string, what: string, id: unknown];

/** The column head. */
export function IdsTh() {
  return <th className="acct-ids" title="SoDEX's ids for each row: click one to copy it whole">IDs</th>;
}

/** The ids of one row, and "Copy details". */
export function IdsCell(props: IdsProps) {
  return (
    <td className="acct-ids" onClick={(e) => e.stopPropagation()}>
      <IdsBlock {...props} />
    </td>
  );
}

interface IdsProps {
  ids: readonly IdEntry[];
  /** The support-ticket block, built when asked for. */
  details: () => string;
}

/** The same, outside a table (a Position History card). */
export function IdsBlock({ ids, details }: IdsProps) {
  const shown = ids.filter(([, , id]) => idText(id) !== null);
  return (
    <span className="acct-ids__in">
      {shown.length ? (
        <span className="acct-ids__list">
          {shown.map(([label, what, id]) => <IdChip key={label} label={label} what={what} id={id} />)}
        </span>
      ) : <span className="acct-dim">{DASH}</span>}
      <button
        type="button"
        className="acct-act acct-ids__details"
        title="Copy this row's market, side, size, price, time (UTC), ids and account as plain text for a support ticket"
        onClick={(e) => { e.stopPropagation(); copyText(details(), 'Details copied'); }}
      >
        Copy details
      </button>
    </span>
  );
}

const CopyIcon = () => (
  <svg className="acct-id__ic" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round">
    <rect x="3.8" y="3.8" width="6.4" height="6.4" rx="1.2" />
    <path d="M8.2 2.6V2.4a.9.9 0 0 0-.9-.9H2.4a.9.9 0 0 0-.9.9v4.9a.9.9 0 0 0 .9.9h.2" />
  </svg>
);
