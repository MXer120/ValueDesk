/**
 * The ONE settings / preferences glyph: three sliders. It replaces the rayed
 * gear, which at 14-20px read as a sun. Stroked in currentColor on a 20 box,
 * drawn to the edges like the other navbar glyphs; any size scales it.
 */
export function PrefsIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M2 5h16M2 10h16M2 15h16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.55" />
      <circle cx="13" cy="5" r="2.2" fill="var(--bg-panel, #1a1a1a)" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="10" r="2.2" fill="var(--bg-panel, #1a1a1a)" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11.5" cy="15" r="2.2" fill="var(--bg-panel, #1a1a1a)" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
