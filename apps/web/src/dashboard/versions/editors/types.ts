/**
 * What every editor version is handed by Dashboard.tsx: exactly what the original editor (EditMode.tsx) gets - the
 * same saved layouts, presets, history and the same actions on them - and a few more facts and actions the new
 * designs draw with (the panels' places on the page, a picked panel, remove and resize one).
 *
 * Nothing here writes storage itself: every change goes through Dashboard's own commit (Undo, the layout history on
 * Done), so a layout made in any editor is the same record and loads in every version of the page.
 */
import type { EditPreset, EditThumb, EditWidget, PreviewGesture } from '../../EditMode';
import type { BreakpointName } from '../../types';

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

/** What the original editor is handed too (Dashboard.tsx builds it once for either). */
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
