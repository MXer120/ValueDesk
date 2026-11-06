/**
 * Opening the feedback chat (FeedbackHost.tsx, mounted once by App.tsx) from anywhere: More and the
 * wallet menu on every page, Settings' Help & FAQ, the status page, a right-click (FeedbackMenu.tsx)
 * and a reply in the bell. The shell test (feedback.test.tsx) fails if More stops offering it: the
 * site does not go live without it (docs/GO-LIVE.md).
 */
import type { ElementInfo } from './element';
import './feedback.css';
import { currentLanguage, languageName } from '../i18n/store';

export const OPEN_FEEDBACK_EVENT = 'vs:open-feedback';

export interface OpenFeedback {
  /** The right-clicked element, attached to the next message. */
  element?: ElementInfo;
  /** Open this thread (a reply in the bell). */
  thread?: string;
  /** Start the form on these areas (ids of ops/feedbackAreas.ts)... */
  areas?: string[];
  /** ...and with this text, for the sender to finish. */
  draft?: string;
}

/** Open the feedback chat from anywhere. */
export function openFeedback(o: OpenFeedback = {}): void {
  window.dispatchEvent(new CustomEvent<OpenFeedback>(OPEN_FEEDBACK_EVENT, { detail: o }));
}

/** The feedback form, set up to say a translation is wrong: the language is named, the area chosen. */
export function reportTranslation(element?: ElementInfo): void {
  openFeedback({ element, areas: ['translations'], draft: `Language: ${languageName(currentLanguage())}\nShown: \nShould say: ` });
}

export const FEEDBACK_LABEL = 'Send feedback';

/* A speech bubble, stroked in currentColor. */
export const FeedbackIcon = () => (
  <svg className="fb-entry__glyph" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path
      d="M2.2 3.4c0-.9.7-1.6 1.6-1.6h8.4c.9 0 1.6.7 1.6 1.6v6c0 .9-.7 1.6-1.6 1.6H7.4l-3.2 2.9V11H3.8c-.9 0-1.6-.7-1.6-1.6z"
      fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
    />
    <path d="M5.2 5.6h5.6M5.2 7.9h3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
