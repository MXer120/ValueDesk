/**
 * KNOWLEDGE FOLDERS - what the server keeps for a wallet's research, and the
 * shapes the web reads (apps/web/src/folders/, through the `@sign` alias).
 *
 * A wallet keeps up to FolderLimits.folders folders; a folder holds items of a
 * few kinds:
 *
 *   note    rich text, as blocks of styled spans (NoteData) - never HTML, so
 *           nothing stored can run as markup when it is shown again
 *   table   a grid of text cells with a header row (TableData)
 *   chart   a chart snapshot as the chart exports it (apps/web/src/folders/bridge.ts
 *           ChartSnapshot): reopened as a live chart, not a picture
 *   news    a story saved from the News widget (SavedNews)
 *   file    an uploaded PDF, image or text file; the bytes are kept apart and
 *           served to their wallet only
 *
 * Pure types and constants: no Node import, so the browser bundle can use it.
 */

export const ITEM_KINDS = ['note', 'table', 'chart', 'news', 'file'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** The kinds made from JSON (everything but an upload). */
export type JsonKind = Exclude<ItemKind, 'file'>;

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

/** A rich-text span: its text and its marks; a link only to http(s) or mailto. */
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

/** A table: column names, then rows of text cells (each row as long as `columns`). */
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
  /** news: where it links, when it was published, who wrote it. */
  href?: string;
  time?: number;
  author?: string | null;
  /** note: its first words. */
  excerpt?: string;
  /** table: its size. */
  rows?: number;
  cols?: number;
  /** file: what it is (sniffed) and the name it was uploaded with. */
  fileType?: FileType;
  fileName?: string;
  /** chart: a thumbnail is kept (GET /api/folders/file?id=&thumb=1). */
  thumb?: boolean;
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
  data: NoteData | TableData | SavedNewsData | Record<string, unknown> | null;
}

/** A refusal: `code` says which rule, `error` says it in a sentence for the user. */
export interface FoldersError {
  ok: false;
  code:
    | 'session' | 'signature' | 'replay' | 'input' | 'not-found' | 'conflict'
    | 'folders-full' | 'folder-full' | 'too-large' | 'quota' | 'storage-full' | 'rate' | 'file-type' | 'unavailable';
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
