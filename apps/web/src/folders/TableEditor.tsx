/**
 * A table, edited in place: click a cell (or a header) to type in it, Enter or
 * Tab to move on, paste a block copied from a spreadsheet into a cell to fill
 * from there; right-click for rows and columns (insert, delete, sort). Saved as
 * you type (autosave.ts); "CSV" downloads it (table.ts toCsv, formula-safe).
 *
 * Only the cell being edited is an input, so a full table (1,000 rows) stays
 * one light grid of text.
 */
import { useCallback, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { FolderItem, TableData } from '@sign/folders/types.js';
import { TABLE_MAX } from '@sign/folders/types.js';
import { MENU_ICONS, TabMenu, menuAt, type TabMenuItem } from '../dashboard/tabExtras';
import { STATUS_LABEL, useAutosave } from './autosave';
import { addColumn, addRow, cellNumber, parseGrid, pasteGrid, removeColumn, removeRow, setCell, sortBy, toCsv } from './table';
import { saveBlob } from './ui';
import { useFolders } from './state';

type Pos = { row: number; col: number }; // row -1: the header

export function TableEditor({ item, data }: { item: FolderItem; data: TableData }) {
  const s = useFolders();
  const [table, setTable] = useState<TableData>(data);
  const latest = useRef(table);
  const [edit, setEdit] = useState<Pos | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: TabMenuItem[] } | null>(null);
  const read = useCallback(() => latest.current, []);
  const auto = useAutosave(item, read, s.list?.limits.jsonBytes.table ?? 200 * 1024);

  const apply = (next: TableData) => {
    latest.current = next;
    setTable(next);
    auto.touched();
  };

  const move = (p: Pos, dRow: number, dCol: number): Pos | null => {
    let { row, col } = p;
    col += dCol;
    if (col >= table.columns.length) {
      col = 0;
      row += 1;
    } else if (col < 0) {
      col = table.columns.length - 1;
      row -= 1;
    }
    row += dRow;
    if (row < -1) return null;
    if (row >= table.rows.length) {
      if (table.rows.length >= TABLE_MAX.rows) return null;
      apply(addRow(latest.current));
    }
    return { row, col };
  };

  const cellKey = (e: KeyboardEvent<HTMLInputElement>, p: Pos) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setEdit(move(p, 1, 0));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      setEdit(move(p, 0, e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      setEdit(null);
    }
  };

  const cellPaste = (e: ReactClipboardEvent<HTMLInputElement>, p: Pos) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text.includes('\t') && !text.includes('\n')) return;
    e.preventDefault();
    apply(pasteGrid(latest.current, Math.max(0, p.row), p.col, parseGrid(text)));
    setEdit(null);
  };

  const cellMenu = (e: ReactMouseEvent, p: Pos) => {
    const t = latest.current;
    setMenu({
      at: menuAt(e),
      items: [
        ...(p.row >= 0
          ? [
              { label: 'Insert row above', icon: MENU_ICONS.up, disabled: t.rows.length >= TABLE_MAX.rows, onClick: () => apply(addRow(latest.current, p.row)) },
              { label: 'Insert row below', icon: MENU_ICONS.down, disabled: t.rows.length >= TABLE_MAX.rows, onClick: () => apply(addRow(latest.current, p.row + 1)) },
            ]
          : []),
        { label: 'Insert column left', icon: MENU_ICONS.add, disabled: t.columns.length >= TABLE_MAX.columns, onClick: () => apply(addColumn(latest.current, p.col)) },
        { label: 'Insert column right', icon: MENU_ICONS.add, disabled: t.columns.length >= TABLE_MAX.columns, onClick: () => apply(addColumn(latest.current, p.col + 1)) },
        { label: 'Sort ascending', icon: MENU_ICONS.up, onClick: () => apply(sortBy(latest.current, p.col, 'asc')) },
        { label: 'Sort descending', icon: MENU_ICONS.down, onClick: () => apply(sortBy(latest.current, p.col, 'desc')) },
        ...(p.row >= 0 ? [{ label: 'Delete row', icon: MENU_ICONS.remove, danger: true, onClick: () => apply(removeRow(latest.current, p.row)) }] : []),
        { label: 'Delete column', icon: MENU_ICONS.remove, danger: true, disabled: t.columns.length <= 1, onClick: () => apply(removeColumn(latest.current, p.col)) },
      ],
    });
  };

  const cell = (value: string, p: Pos) => {
    const on = edit?.row === p.row && edit.col === p.col;
    const Tag = p.row < 0 ? 'th' : 'td';
    return (
      <Tag
        key={p.col}
        className={`${on ? 'is-edit' : ''}${p.row >= 0 && cellNumber(value) !== null ? ' is-num' : ''}`}
        onClick={() => setEdit(p)}
        onContextMenu={(e) => cellMenu(e, p)}
      >
        {on ? (
          <input
            className="kf-table__input"
            autoFocus
            value={value}
            maxLength={TABLE_MAX.cellChars}
            aria-label={p.row < 0 ? `Column ${p.col + 1} name` : `Row ${p.row + 1}, ${table.columns[p.col] || `column ${p.col + 1}`}`}
            onChange={(e) => apply(setCell(latest.current, p.row, p.col, e.target.value))}
            onKeyDown={(e) => cellKey(e, p)}
            onPaste={(e) => cellPaste(e, p)}
            onBlur={() => setEdit((cur) => (cur && cur.row === p.row && cur.col === p.col ? null : cur))}
          />
        ) : (
          value || ' '
        )}
      </Tag>
    );
  };

  return (
    <div className="kf-table">
      <div className="kf-tools" role="toolbar" aria-label="Table">
        <button type="button" className="kf__addbtn" disabled={table.rows.length >= TABLE_MAX.rows} onClick={() => apply(addRow(latest.current))}>
          {MENU_ICONS.add} Row
        </button>
        <button type="button" className="kf__addbtn" disabled={table.columns.length >= TABLE_MAX.columns} onClick={() => apply(addColumn(latest.current))}>
          {MENU_ICONS.add} Column
        </button>
        <button type="button" className="kf__addbtn" onClick={() => saveBlob(new Blob([toCsv(latest.current)], { type: 'text/csv;charset=utf-8' }), `${item.title || 'table'}.csv`)}>
          {MENU_ICONS.download} CSV
        </button>
        <span className="kf-tools__fill" />
        <span className="kf-table__size">{table.rows.length} × {table.columns.length}</span>
        <span className={`kf-save-state is-${auto.status}`} role="status">{STATUS_LABEL[auto.status]}</span>
      </div>
      {(auto.status === 'conflict' || auto.status === 'error' || auto.status === 'too-large') && auto.message && (
        <div className="kf-conflict" role="alert">
          <span>{auto.message}</span>
          {auto.status === 'conflict' && (
            <>
              <button
                type="button"
                className="kf__addbtn"
                onClick={async () => {
                  const fresh = await auto.loadTheirs();
                  if (fresh) {
                    latest.current = fresh.data as TableData;
                    setTable(fresh.data as TableData);
                  }
                }}
              >
                Load that version
              </button>
              <button type="button" className="kf__addbtn" onClick={auto.keepMine}>Keep mine</button>
            </>
          )}
          {auto.status === 'error' && <button type="button" className="kf__addbtn" onClick={() => void auto.save()}>Try again</button>}
        </div>
      )}
      <div className="kf-table__scroll">
        <table className="kf-table__grid">
          <thead>
            <tr>
              <th className="kf-table__n" aria-hidden="true" />
              {table.columns.map((c, col) => cell(c, { row: -1, col }))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, row) => (
              <tr key={row}>
                <td className="kf-table__n" aria-hidden="true">{row + 1}</td>
                {r.map((v, col) => cell(v, { row, col }))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="kf__hint">Click a cell to type. Paste cells copied from a spreadsheet into one cell to fill from there. Right-click for rows, columns and sorting.</p>
      {menu && <TabMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
