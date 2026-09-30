/**
 * Generic tab group used to combine panels that used to be stacked (order
 * book/trades, positions/orders/history) into one module with a tab bar.
 *
 * Inactive tabs unmount rather than just hiding with CSS, so a panel that
 * polls or holds a WebSocket subscription stops doing so while its tab isn't
 * selected.
 */
import { useState, type ReactNode } from 'react';

export interface TabItem {
  key: string;
  label: ReactNode;
  content: ReactNode;
}

export function Tabs({ tabs, className }: { tabs: TabItem[]; className?: string }) {
  const [active, setActive] = useState(tabs[0]?.key);
  const current = tabs.find((t) => t.key === active) ?? tabs[0];

  return (
    <section className={`panel tabpanel ${className ?? ''}`}>
      <div className="tabbar" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === current?.key}
            className={t.key === current?.key ? 'active' : ''}
            onClick={() => setActive(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="tabbody">{current?.content}</div>
    </section>
  );
}
