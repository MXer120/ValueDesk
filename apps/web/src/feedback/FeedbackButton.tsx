/**
 * The "Send feedback" entry: in the workspace bar at the bottom of every page
 * (StatusFooter.tsx), so it is on screen wherever a visitor runs into something.
 * The shell test (feedback.test.tsx) fails if the bar stops rendering it - the
 * site does not go live without it (docs/GO-LIVE.md).
 *
 * It opens the feedback chat (FeedbackHost.tsx, mounted once by App.tsx). So do
 * Settings' Help & FAQ, the status page, a right-click (FeedbackMenu.tsx) and a
 * reply in the bell - all through `openFeedback()`.
 */
import { useSyncExternalStore } from 'react';
import type { ElementInfo } from './element';
import { hasUnread, onUnread } from './threads';
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

/** A dot while the team's reply waits - known without a signature (threads.ts pollUnread). */
export function FeedbackButton() {
  const unread = useSyncExternalStore(onUnread, hasUnread, () => false);
  const title = unread ? `${FEEDBACK_LABEL} - a new reply is waiting` : FEEDBACK_LABEL;
  return (
    <button type="button" className={`fb-entry${unread ? ' has-unread' : ''}`} title={title} aria-label={title} aria-haspopup="dialog" data-feedback-entry="" onClick={() => openFeedback()}>
      <span className="fb-entry__ic">
        <FeedbackIcon />
        {unread && <span className="fb-entry__dot" aria-hidden="true" />}
      </span>
      <span className="fb-entry__word">{FEEDBACK_LABEL}</span>
    </button>
  );
}

/* A speech bubble, stroked in currentColor like the bar's other glyphs (StatusFooter.tsx). */
export const FeedbackIcon = () => (
  <svg className="fb-entry__glyph" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path
      d="M2.2 3.4c0-.9.7-1.6 1.6-1.6h8.4c.9 0 1.6.7 1.6 1.6v6c0 .9-.7 1.6-1.6 1.6H7.4l-3.2 2.9V11H3.8c-.9 0-1.6-.7-1.6-1.6z"
      fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
    />
    <path d="M5.2 5.6h5.6M5.2 7.9h3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
