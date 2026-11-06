/**
 * The legal pages: /impressum, /privacy, /cookies, /terms, /risk, /copy-terms
 * (texts in impressum.ts, privacy.ts, cookies.ts, terms.ts, risk.ts,
 * copyTerms.ts; the format in model.ts).
 *
 * A chunk of its own (App.tsx lazyPage), so the texts cost the first load
 * nothing; it loads when a legal link is hovered, focused or followed, or when
 * the app starts on a legal URL.
 *
 * One card in the middle of the page: the panel header strip with the title
 * and the legal pages as a segment (`.lbp-seg`), then the text at the base
 * step. While a page still holds an `[[OWNER: ...]]` placeholder it says
 * "Draft - not yet legally reviewed", and the placeholders are highlighted.
 */
import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { LEGAL_LABELS, LEGAL_PAGES, legalForPath, type LegalPage } from '../router';
import { ANALYTICS_SECTION_TITLE, EMBED_SECTION_TITLE, REOWN_SECTION_TITLE } from './cookies';
import { LEGAL_DOCS } from './docs';
import { AnalyticsSwitch, EmbedSwitches, ReownSwitch } from './LegalGate';
import { MARKER_INLINE, isDraft, type Block } from './model';
import './legal.css';
import { useLanguage } from '../i18n/store';

export interface LegalViewProps {
  page: LegalPage;
  /** Show another legal page in place (App.tsx: pushes history). */
  onOpen: (page: LegalPage) => void;
}

export function LegalView({ page, onOpen }: LegalViewProps) {
  const lang = useLanguage();
  const doc = LEGAL_DOCS[page];
  const draft = isDraft(doc);
  const root = useRef<HTMLElement>(null);

  /* A new page starts at its top: the page scrolls inside `.appcontent`, which
     another legal page left wherever its reader was. */
  useLayoutEffect(() => {
    const scroller = root.current?.closest('.appcontent');
    if (scroller) scroller.scrollTop = 0;
  }, [page]);

  return (
    <main className="legal" ref={root}>
      <article className="legal-card" lang={doc.lang}>
        {doc.lang === 'en' && lang !== 'en' && <p className="legal-only-en" lang={lang}>This document is available in English only, and the English text is what counts.</p>}
        <header className="legal-head">
          <h1 className="legal-title" data-no-i18n="">{doc.title}</h1>
          <nav className="lbp-seg" aria-label="Legal pages" lang="en">
            {LEGAL_PAGES.map((p) => (
              <button
                key={p}
                type="button"
                className={p === page ? 'is-on' : ''}
                aria-current={p === page ? 'page' : undefined}
                onClick={() => onOpen(p)}
              >
                {LEGAL_LABELS[p]}
              </button>
            ))}
          </nav>
        </header>
        <div className="legal-body" data-no-i18n="">
          {draft && <p className="legal-draft" role="note" lang="en">Draft – not yet legally reviewed</p>}
          {doc.intro && <Blocks blocks={doc.intro} onOpen={onOpen} />}
          {doc.sections.map((s, i) => (
            <section key={i} className="legal-section" lang={s.lang}>
              <h2><Inline text={s.title} onOpen={onOpen} /></h2>
              <Blocks blocks={s.blocks} onOpen={onOpen} />
              {/* The one control on a legal page: withdrawing consent for a video platform. */}
              {page === 'cookies' && s.title === EMBED_SECTION_TITLE && <EmbedSwitches />}
              {page === 'cookies' && s.title === REOWN_SECTION_TITLE && <ReownSwitch />}
              {page === 'cookies' && s.title === ANALYTICS_SECTION_TITLE && <AnalyticsSwitch />}
            </section>
          ))}
          <p className="legal-updated">
            {doc.lang === 'de' ? 'Stand' : 'Last updated'}: <Inline text={doc.updated} onOpen={onOpen} />
          </p>
        </div>
      </article>
    </main>
  );
}

function Blocks({ blocks, onOpen }: { blocks: Block[]; onOpen: (p: LegalPage) => void }) {
  return (
    <>
      {blocks.map((b, i) => {
        if ('p' in b) return <p key={i}><Inline text={b.p} onOpen={onOpen} /></p>;
        if ('ul' in b) {
          return (
            <ul key={i}>
              {b.ul.map((item, j) => <li key={j}><Inline text={item} onOpen={onOpen} /></li>)}
            </ul>
          );
        }
        return (
          <p key={i} className="legal-lines">
            {b.lines.map((line, j) => <span key={j}><Inline text={line} onOpen={onOpen} /></span>)}
          </p>
        );
      })}
    </>
  );
}

/* Placeholders first, so a marker is never read as a link; then links, then **emphasis**. */
const TOKEN = new RegExp(`(${MARKER_INLINE.source}|\\[[^\\]]+\\]\\([^)\\s]+\\)|\\*\\*[^*]+\\*\\*)`, 'gi');
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

/** One line of legal text: the three inline forms of model.ts, everything else as plain text. */
function Inline({ text, onOpen }: { text: string; onOpen: (p: LegalPage) => void }) {
  const parts = text.split(TOKEN);
  const out: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 0) {
      out.push(part);
      return;
    }
    if (MARKER_INLINE.test(part)) {
      out.push(<mark key={i} className="legal-owner">{part}</mark>);
      return;
    }
    if (part.startsWith('**')) {
      out.push(<strong key={i}>{part.slice(2, -2)}</strong>);
      return;
    }
    const m = LINK.exec(part);
    const [label, href] = [m?.[1] ?? part, m?.[2] ?? ''];
    const inApp = href.startsWith('/') ? legalForPath(href) : null;
    if (inApp) {
      out.push(
        <a
          key={i}
          href={href}
          onClick={(e: MouseEvent<HTMLAnchorElement>) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            onOpen(inApp);
          }}
        >
          {label}
        </a>,
      );
    } else if (/^https:\/\//.test(href)) {
      out.push(<a key={i} href={href} target="_blank" rel="noopener noreferrer">{label}</a>);
    } else if (/^mailto:/.test(href)) {
      out.push(<a key={i} href={href}>{label}</a>);
    } else if (/^\/[\w-]+\.txt$/.test(href)) {
      // A plain-text file the site serves (the build's third-party-licenses.txt).
      out.push(<a key={i} href={href} target="_blank" rel="noopener">{label}</a>);
    } else {
      out.push(label);
    }
  });
  return <>{out}</>;
}
