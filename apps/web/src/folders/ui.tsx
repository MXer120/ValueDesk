/**
 * Small pieces the folders view, the item pane and the editors share.
 */
import { useRef, useState } from 'react';

/** Bytes as the folders show them: KB below a megabyte, MB above. */
export const mb = (n: number): string =>
  n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1)} MB` : n <= 0 ? '0 KB' : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Hand a blob to the browser as a download (never opened in this page). */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** An inline name field: Enter or leaving it saves, Escape keeps the old name. */
export function NameInput({ initial, max, label, placeholder, onDone }: { initial: string; max: number; label: string; placeholder?: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="kf__name"
      value={v}
      maxLength={max}
      aria-label={label}
      placeholder={placeholder}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(v.trim() || null);
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}

