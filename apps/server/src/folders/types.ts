/**
 * KNOWLEDGE FOLDERS - what the server keeps for a wallet's research, and the
 * shapes the web reads (apps/web/src/folders/, through the `@sign` alias).
 *
 * A wallet keeps up to FolderLimits.folders folders; a folder holds items of a
 * few kinds:
 *
 *   doc     a rich document, as the editor's tree of nodes and marks (DocData;
 *           apps/web/src/knowledge/doc) - never HTML, so nothing stored can run
 *           as markup when it is shown again
 *   sheet   a spreadsheet: tabs of sparse cells, each the text the user typed -
 *           a value or a formula, computed in the browser (SheetData)
 *   board   a canvas of shapes, sticky notes, text, arrows, pen strokes, images
 *           and cards of other items (BoardData)
 *   tweet   a post on X saved by its link, with its text as X's embed gave it
 *           (TweetData), the user's own note and tags
 *   chart   a chart snapshot as the chart exports it (apps/web/src/folders/bridge.ts
 *           ChartSnapshot): reopened as a live chart, not a picture
 *   news    a story saved from the News widget (SavedNews)
 *   file    an uploaded PDF, image or text file; the bytes are kept apart and
 *           served to their wallet only. A file can belong to a doc or a board
 *           (an image in it): an ATTACHMENT, not listed in the folder, deleted
 *           with it (ItemSummary.parentId)
 *
 * The first release (2026-10-24) had `note` (blocks of spans) and `table` (a
 * plain grid); the store turns any it finds into a doc and a sheet (legacy.ts).
 *
 * Pure types and constants: no Node import, so the browser bundle can use it.
 */

export const ITEM_KINDS = ['doc', 'sheet', 'board', 'tweet', 'chart', 'news', 'file'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** The kinds made from JSON (everything but an upload). */
export type JsonKind = Exclude<ItemKind, 'file'>;

/** The kinds whose content changes after it is saved (the rest keep what was saved; a title always can). */
export const EDITABLE_KINDS: readonly JsonKind[] = ['doc', 'sheet', 'board', 'tweet'];

/** The kinds a file can be attached to (an image in it). */
export const ATTACHING_KINDS: readonly JsonKind[] = ['doc', 'board'];

/** The limits a server enforces, as it reports them to the web (GET /api/folders). */
export interface FolderLimits {
  /** Folders per wallet. */
  folders: number;
  /** Items per folder. */
  itemsPerFolder: number;
  /** One uploaded file, bytes. */
  fileBytes: number;
  /** Everything a wallet keeps (text, tables, snapshots, files, thumbnails), bytes. */
  walletBytes: number;
  /** One item's JSON, bytes, by kind. */
  jsonBytes: Record<JsonKind, number>;
  /** A chart snapshot's thumbnail, bytes (decoded). */
  thumbBytes: number;
  /** Changes a wallet may make per minute. */
  writesPerMinute: number;
  /** Uploads a wallet may make per hour. */
  uploadsPerHour: number;
  /** Files attached to one doc or board (its images). */
  attachmentsPerItem: number;
  /** Characters in a folder's name and an item's title. */
  nameChars: number;
  titleChars: number;
}

/** What an uploaded file may be: sniffed from its bytes, never taken from the client. */
export const FILE_TYPES = {
  pdf: { mime: 'application/pdf', label: 'PDF' },
  png: { mime: 'image/png', label: 'PNG image' },
  jpeg: { mime: 'image/jpeg', label: 'JPEG image' },
  webp: { mime: 'image/webp', label: 'WebP image' },
  gif: { mime: 'image/gif', label: 'GIF image' },
  text: { mime: 'text/plain; charset=utf-8', label: 'Text' },
} as const;
export type FileType = keyof typeof FILE_TYPES;
export const isImageType = (t: FileType | null | undefined): boolean => t === 'png' || t === 'jpeg' || t === 'webp' || t === 'gif';

/** A color a doc, a sheet or a board may use: #rrggbb, or #rrggbbaa with its opacity. */
export const COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** An item's or a board element's id: what newId() makes (16 base64url characters), or a board's own shorter ones. */
export const ITEM_ID_RE = /^[A-Za-z0-9_-]{16}$/;

/* ------------------------------------------------------------------- doc ----- */

/**
 * A doc is the editor's (TipTap / ProseMirror) JSON tree: nodes with a type,
 * attributes and children, text nodes with marks. Only the types and the
 * attributes below are kept (validate.ts checkDoc rebuilds every node):
 *
 *   blocks   paragraph, heading (1-3), blockquote, bulletList, orderedList,
 *            listItem, taskList, taskItem, codeBlock, horizontalRule, table,
 *            tableRow, tableHeader, tableCell, image (an attachment, by id),
 *            itemRef (a card of another item in the wallet's folders)
 *   inline   text, hardBreak
 *   marks    bold, italic, underline, strike, code, link (http, https, mailto),
 *            highlight and textStyle (a color)
 */
export interface DocMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: DocMark[];
  text?: string;
}
export interface DocData {
  v: 1;
  doc: DocNode;
}
export const DOC_MAX = { depth: 24, nodes: 60_000 } as const;

/* ----------------------------------------------------------------- sheet ----- */

/** A cell's look: marks, alignment, colors, and how its number is shown. */
export interface SheetCellStyle {
  b?: true;
  i?: true;
  u?: true;
  s?: true;
  al?: 'l' | 'c' | 'r';
  fg?: string;
  bg?: string;
  fmt?: 'num' | 'pct' | 'usd' | 'date' | 'text';
  /** Decimals shown (0-10). */
  dp?: number;
  wrap?: true;
}
/** One cell: what the user typed (a value, or a formula starting with "="), and its look. */
export interface SheetCell {
  v: string;
  s?: SheetCellStyle;
}
export interface SheetTab {
  id: string;
  name: string;
  /** Sparse, keyed "A1". */
  cells: Record<string, SheetCell>;
  /** Column widths and row heights that differ from the default, px, by index ("0" is A / row 1). */
  cols?: Record<string, number>;
  rows?: Record<string, number>;
  /** Rows and columns kept in view while scrolling. */
  freeze?: { r: number; c: number };
}
export interface SheetData {
  v: 1;
  sheets: SheetTab[];
  active?: number;
}
export const SHEET_MAX = { sheets: 12, rows: 5000, cols: 100, cells: 60_000, cellChars: 4000, nameChars: 40 } as const;

/* ----------------------------------------------------------------- board ----- */

export const BOARD_TYPES = ['sticky', 'text', 'rect', 'ellipse', 'diamond', 'line', 'arrow', 'pen', 'image', 'item', 'frame'] as const;
export type BoardType = (typeof BOARD_TYPES)[number];
export const BOARD_ENDS = ['none', 'arrow', 'triangle', 'dot', 'bar'] as const;
export type BoardEnd = (typeof BOARD_ENDS)[number];

/**
 * One thing on a board, in board units (its box: x, y, w, h). Order in the
 * list is the order on screen (last on top).
 *
 *   line, arrow   points = [x1, y1, x2, y2] relative to the box; `from`/`to` are
 *                 the elements its ends are attached to (they follow them)
 *   pen           points = [x0, y0, x1, y1, …] relative to the box
 *   image         file = an attachment of the board
 *   item          ref = another item in the wallet's folders, shown as its card
 *   frame         a titled area (name); what lies inside moves with it
 */
export interface BoardElement {
  id: string;
  type: BoardType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise. */
  rot?: number;
  text?: string;
  fill?: string;
  stroke?: string;
  /** Stroke width. */
  sw?: number;
  /** Opacity, 0.05-1. */
  op?: number;
  /** Font size. */
  fs?: number;
  align?: 'l' | 'c' | 'r';
  valign?: 't' | 'm' | 'b';
  bold?: boolean;
  dash?: 'solid' | 'dashed' | 'dotted';
  radius?: number;
  points?: number[];
  from?: string;
  to?: string;
  head?: BoardEnd;
  tail?: BoardEnd;
  file?: string;
  ref?: string;
  name?: string;
  lock?: boolean;
  group?: string;
}
export interface BoardData {
  v: 1;
  elements: BoardElement[];
  bg?: 'dots' | 'grid' | 'none';
}
export const BOARD_MAX = { elements: 4000, points: 8000, text: 10_000, coord: 10_000_000, size: 1_000_000 } as const;

/* ----------------------------------------------------------------- tweet ----- */

/**
 * A post on X, saved by its link. `text`, `author` and `time` are what X's own
 * embed endpoint (publish.x.com/oembed) said when it was saved, fetched by the
 * server (routes/folders.ts GET /api/folders/tweet) - the browser never loads
 * anything from X. `fetched` is false when X would not show it (deleted,
 * private): then only the link is kept, with what the user writes.
 */
export interface TweetData {
  url: string;
  id: string;
  handle: string;
  author: string;
  text: string;
  /** When it was posted (ms), as far as the embed says (a day). */
  time: number | null;
  lang?: string;
  fetched: boolean;
  /** The user's own words about it. */
  note?: string;
  tags?: string[];
}
export const TWEET_MAX = { text: 30_000, note: 5000, tags: 12, tagChars: 32 } as const;

/* ---------------------------------------------------------------- legacy ----- */

/** The first release's note (2026-10-24): blocks of spans. Turned into a doc (legacy.ts). */
export type NoteMark = 'b' | 'i' | 'u' | 's' | 'code';
export const NOTE_MARKS: readonly NoteMark[] = ['b', 'i', 'u', 's', 'code'];
export interface NoteSpan {
  text: string;
  marks?: NoteMark[];
  href?: string;
}
export type NoteTextBlock = { type: 'p' | 'h1' | 'h2' | 'h3' | 'quote' | 'pre'; spans: NoteSpan[] };
export type NoteListBlock = { type: 'ul' | 'ol'; items: NoteSpan[][] };
export type NoteBlock = NoteTextBlock | NoteListBlock | { type: 'hr' };
export const NOTE_TEXT_BLOCKS = ['p', 'h1', 'h2', 'h3', 'quote', 'pre'] as const;
export interface NoteData {
  blocks: NoteBlock[];
}

/** The first release's table: column names, then rows of text cells. Turned into a sheet (legacy.ts). */
export interface TableData {
  columns: string[];
  rows: string[][];
}
export const TABLE_MAX = { columns: 30, rows: 1000, cellChars: 1000 } as const;

/** A story from the News widget (apps/web/src/folders/bridge.ts SavedNews). */
export interface SavedNewsData {
  id: string;
  title: string;
  href: string;
  time: number;
  author: string | null;
  symbols: string[];
  summary?: string | null;
  post?: boolean;
}

/** What the list shows of an item without loading it. */
export interface ItemMeta {
  /** chart: the market and timeframe. */
  engine?: string;
  symbol?: string;
  interval?: string;
  /** news, tweet: where it links, when it was published, who wrote it. */
  href?: string;
  time?: number | null;
  author?: string | null;
  /** tweet: the account's handle (without @); its tags. */
  handle?: string;
  tags?: string[];
  /** doc, tweet: the first words. */
  excerpt?: string;
  /** sheet: its tabs and the cells that hold something. */
  sheets?: number;
  cells?: number;
  /** board: how many things are on it. */
  elements?: number;
  /** file: what it is (sniffed) and the name it was uploaded with. */
  fileType?: FileType;
  fileName?: string;
  /** chart: a thumbnail is kept (GET /api/folders/file/url?id=&thumb=1), and what it is. */
  thumb?: boolean;
  thumbType?: 'png' | 'jpeg';
}

export interface ItemSummary {
  id: string;
  folderId: string;
  kind: ItemKind;
  title: string;
  /** Everything this item takes from the wallet's storage, bytes. */
  bytes: number;
  meta: ItemMeta;
  createdAt: number;
  updatedAt: number;
  /** Bumped by every change; an update that names an older one is refused (another tab changed it). */
  rev: number;
  /** An attachment: the doc or board it belongs to (not listed in the folder, deleted with it). */
  parentId?: string;
}

export interface FolderSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** In their order. */
  items: ItemSummary[];
}

export interface FoldersUsage {
  bytes: number;
  folders: number;
  items: number;
}

/** GET /api/folders */
export interface FoldersList {
  ok: true;
  owner: string;
  folders: FolderSummary[];
  usage: FoldersUsage;
  limits: FolderLimits;
}

/** GET /api/folders/item: one item with its content (a file's bytes come from /api/folders/file). */
export interface FolderItem extends ItemSummary {
  data: DocData | SheetData | BoardData | TweetData | SavedNewsData | Record<string, unknown> | null;
}

/** A refusal: `code` says which rule, `error` says it in a sentence for the user. */
export interface FoldersError {
  ok: false;
  code:
    | 'session' | 'signature' | 'replay' | 'input' | 'not-found' | 'conflict'
    | 'folders-full' | 'folder-full' | 'too-large' | 'quota' | 'storage-full' | 'rate' | 'file-type' | 'unavailable' | 'closed';
  error: string;
}

/* --------------------------------------------------------------- sign-in ----- */

/**
 * The sign-in a wallet gives once per browser: free EIP-712 typed data, never a
 * transaction. The statement is fixed, so the wallet shows exactly what it is
 * for; the nonce is the browser's and is accepted once.
 *
 *   FoldersSignIn(address owner,string statement,string nonce,uint64 issuedAt,uint64 expiresAt)
 *
 * The domain's chainId is the wallet's current chain (wallets refuse typed data
 * for another), as for the copy executor's session.
 */
export const SIGN_IN_DOMAIN = { name: 'ValueDesk Folders', version: '1' } as const;
export const SIGN_IN_STATEMENT = 'Open my ValueDesk knowledge folders in this browser. Free: a signature, never a transaction.';
export const SIGN_IN_TYPE = 'FoldersSignIn(address owner,string statement,string nonce,uint64 issuedAt,uint64 expiresAt)';
/** How long a signed sign-in may be used after it was made. */
export const SIGN_IN_TTL_MS = 10 * 60_000;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface SignIn {
  owner: string;
  statement: string;
  /** 32 hex characters from the browser. */
  nonce: string;
  /** ms, decimal strings (uint64 in the typed data). */
  issuedAt: string;
  expiresAt: string;
  chainId: number;
  signature: string;
}

/** The typed data the wallet signs (eth_signTypedData_v4). */
export function signInTypedData(s: Omit<SignIn, 'signature'>) {
  return {
    domain: { name: SIGN_IN_DOMAIN.name, version: SIGN_IN_DOMAIN.version, chainId: s.chainId, verifyingContract: ZERO_ADDRESS },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      FoldersSignIn: [
        { name: 'owner', type: 'address' },
        { name: 'statement', type: 'string' },
        { name: 'nonce', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'FoldersSignIn' as const,
    message: { owner: s.owner.toLowerCase(), statement: s.statement, nonce: s.nonce, issuedAt: s.issuedAt, expiresAt: s.expiresAt },
  };
}

/** POST /api/folders/session */
export interface FoldersSession {
  ok: true;
  owner: string;
  token: string;
  expiresAt: number;
}
