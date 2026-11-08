import './InfoDot.css';

/**
 * A small (i) beside a word: its explanation on hover and to screen readers. Shared by Portfolio and the Bots pages
 * (bots/glossary.ts); kept here so a page uses it without loading the portfolio.
 */
export function InfoDot({ title }: { title: string }) {
  return (
    <span className="pfa__info" title={title} aria-label={title} role="img" tabIndex={0}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="8" cy="5" r="0.8" fill="currentColor" /></svg>
    </span>
  );
}
