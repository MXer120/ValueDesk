/**
 * Opening Settings at a section from anywhere (SettingsMenu.tsx listens): the
 * dashboard's right-click menu offers the clicked panel's own settings this way,
 * without the dashboard knowing what Settings holds.
 */
export type SettingsSection = 'appearance' | 'privacy' | 'layout' | 'security' | 'news' | 'players' | 'legal' | 'help';

export const SETTINGS_EVENT = 'vs:settings';

export function openSettings(section: SettingsSection): void {
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: { section } }));
}

/** A panel's settings, by its id (a copy, `news#2`, is its widget's): the menu's label and the section. */
const PANEL_SETTINGS: Record<string, { label: string; section: SettingsSection }> = {
  news: { label: 'News settings', section: 'news' },
  livefeed: { label: 'Player settings', section: 'players' },
  fedlive: { label: 'Player settings', section: 'players' },
  account: { label: 'Privacy settings', section: 'privacy' },
  positions: { label: 'Privacy settings', section: 'privacy' },
  exec: { label: 'Trading key settings', section: 'security' },
  quick: { label: 'Trading key settings', section: 'security' },
};

export function panelSettings(panelId: string | null | undefined): { label: string; run: () => void } | undefined {
  const s = panelId ? PANEL_SETTINGS[panelId.split('#')[0]!] : undefined;
  return s ? { label: s.label, run: () => openSettings(s.section) } : undefined;
}
