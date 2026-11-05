/**
 * The kanban board on dev.valuedesk.so, for the sessions working on ValueDesk (the owner uses the
 * page). From the laptop, through deploy/release/board.sh:
 *
 *   board.sh list [planned|working|done|reviewed]
 *   board.sh show <id>
 *   board.sh add "<title>" [--status=working] [--area=web] [--detail="..."] [--session=name] [--ref=abc123]
 *   board.sh move <id> <planned|working|done> [--session=name] [--ref=abc123] [--note="..."]
 *   board.sh edit <id> [--title="..."] [--detail="..."] [--area=web] [--ref=abc123]
 *   board.sh review <id> --owner-said="the owner's own words" [--session=name]
 *
 * Only the owner decides a card is reviewed. A session moves one there, or takes one out, only
 * with the owner's confirmation quoted, and the quote stays in the card's log.
 */
import { AdminStore, BOARD_STATUSES, BoardError, type BoardCard, type BoardStatus } from '../src/admin/store.js';

const raw = process.argv.slice(2);
const flags = new Map<string, string>();
const words: string[] = [];
for (const a of raw) {
  const m = /^--([a-z-]+)=([\s\S]*)$/.exec(a);
  if (m) flags.set(m[1]!, m[2]!);
  else words.push(a);
}
const [cmd, first, second] = words;
const session = flags.get('session') ?? process.env.BOARD_SESSION ?? 'claude';
const actor = { session };

const line = (c: BoardCard): string => `#${c.id} [${c.status}] ${c.title}${c.area ? ` (${c.area})` : ''}${c.session ? ` <${c.session}>` : ''}${c.ref ? ` ${c.ref}` : ''}`;
const idOf = (v: string | undefined): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new BoardError('a card id is needed');
  return n;
};
const statusOf = (v: string | undefined): BoardStatus => {
  if (!BOARD_STATUSES.includes(v as BoardStatus)) throw new BoardError(`a column is one of ${BOARD_STATUSES.join(', ')}`);
  return v as BoardStatus;
};
const given = (...names: string[]): Record<string, string> => Object.fromEntries(names.flatMap((n) => (flags.has(n) ? [[n, flags.get(n)!]] : [])));

const store = new AdminStore();
try {
  switch (cmd) {
    case 'list': {
      const only = first ? statusOf(first) : null;
      for (const c of store.boardCards()) if (!only || c.status === only) console.log(line(c));
      break;
    }
    case 'show': {
      const id = idOf(first);
      const c = store.boardCard(id);
      if (!c) throw new BoardError(`no card ${id}`);
      console.log(line(c));
      if (c.detail) console.log(c.detail);
      for (const l of store.boardLog(id)) console.log(`${new Date(l.at).toISOString()} ${l.who}: ${l.what}`);
      break;
    }
    case 'add': {
      if (!first) throw new BoardError('a title is needed');
      console.log(line(store.addBoardCard({ title: first, session, ...given('detail', 'area', 'ref'), status: flags.has('status') ? statusOf(flags.get('status')) : 'planned' }, actor)));
      break;
    }
    case 'move': {
      const to = statusOf(second);
      console.log(line(store.moveBoardCard(idOf(first), to, { session, ...(flags.has('owner-said') ? { ownerSaid: flags.get('owner-said')! } : {}) }, { session, ...given('ref', 'note') })));
      break;
    }
    case 'edit':
      console.log(line(store.editBoardCard(idOf(first), given('title', 'detail', 'area', 'session', 'ref'), actor)));
      break;
    case 'review':
      console.log(line(store.moveBoardCard(idOf(first), 'reviewed', { session, ownerSaid: flags.get('owner-said') ?? '' }, given('note'))));
      break;
    default:
      throw new BoardError('commands: list, show, add, move, edit, review');
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  store.close();
}
