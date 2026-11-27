/**
 * What the layout editor (EditDock.tsx) is handed by Dashboard.tsx: the saved layouts, presets, history and the
 * actions on them, and the panels' places on the page, a picked panel, remove and resize one.
 *
 * Nothing here writes storage itself: every change goes through Dashboard's own commit (Undo, the layout history on
 * Done). Dock became the editor on the owner's word (2026-11-26: "editor, dock new default"); the editor before it
 * (EditMode.tsx) is gone and its types live here.
 */
import type { ThumbBlock } from '../editPlace';
import type { BreakpointName } from '../types';
import type { WidgetGroup } from '../widgetCatalog';

export interface EditThumb {
  id: string;
  /** What the rail calls it. */
  name: string;
  /** Taken off the icon rail. */
  off: boolean;
  active: boolean;
  blocks: ThumbBlock[];
}

export interface EditWidget {
  id: string;
  name: string;
  /** What it shows, for the search. */
  blurb?: string;
  /** Already on the canvas. Dragging it must not create a second copy. */
  present: boolean;
  group?: WidgetGroup;
}

export type PreviewGesture = 'hold-start' | 'hold-end' | 'toggle';

export interface EditPreset {
  id: string;
  title: string;
  blurb: string;
  active: boolean;
  blocks: ThumbBlock[];
}

/** Where the page sits while a layout is edited: scaled by `scale` from its top-left, moved by x / y px. */
export interface EditStage { scale: number; x: number; y: number }

export interface PagePanel {
  id: string;
  name: string;
  blurb?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
}

/** What Dashboard.tsx builds once per render for the editor; the rest it adds at the call. */
export type EditBaseProps = Omit<EditorProps, 'bp' | 'phone' | 'pagePanels' | 'rows' | 'layoutName' | 'selected' | 'onSelect' | 'onRemove' | 'onResize' | 'onStage'>;

export interface EditorProps {
  thumbs: EditThumb[];
  presets: EditPreset[];
  history: EditPreset[];
  rail: 'widgets' | 'layouts';
  onRail: (rail: 'widgets' | 'layouts') => void;
  onSetOff: (id: string, off: boolean) => void;
  onRestore: (entryId: string) => void;
  cols: number;
  widgets: EditWidget[];
  quiet: boolean;
  sticky: boolean;
  overDelete: boolean;
  ghost: { name: string; x: number; y: number } | null;
  trash: boolean;
  onTrash: (on: boolean) => void;
  undoTip: { text: string; n: number } | null;
  onUndo: () => void;
  onWidgetAdd: (id: string) => void;
  onSwitch: (id: string) => void;
  onAddSlot: () => void;
  onDeleteSlot: (id: string) => void;
  onApplyPreset: (id: string) => void;
  onDone: () => void;
  onFill: () => void;
  onPreview: (gesture: PreviewGesture) => void;
  onWidgetPointerDown: (id: string, name: string, x: number, y: number) => void;

  /* --- what the new designs add ---------------------------------------- */
  /** The grid's tier: on sm / xs the arrangement is fixed (responsive.css), only which widgets are on it changes. */
  bp: BreakpointName;
  phone: boolean;
  /** The panels on the page now, with their places (columns and rows). */
  pagePanels: PagePanel[];
  /** Rows the page is cut into at this tier (lg: 90), for size read-outs. */
  rows: number;
  /** The layout on screen. */
  layoutName: string;
  /** A panel picked on the page. */
  selected: string | null;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  /** New width and height in columns and rows, kept inside the panel's own limits. */
  onResize: (id: string, w: number, h: number) => void;
  /** Where the editor wants the page while it is open. */
  onStage: (stage: EditStage) => void;
}
