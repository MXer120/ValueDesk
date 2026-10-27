/**
 * The feedback chat's one home in the app (App.tsx mounts it once): the dialog,
 * opened by `openFeedback()` from anywhere; the right-click entry
 * (FeedbackMenu.tsx); and the watch for the ValueDesk team's replies.
 *
 * THE REPLIES. While the tab is visible, every POLL_MS and whenever it comes back
 * into view, this browser asks the server how many replies its threads have
 * (threads.ts pollThreads - one small request for all of them, none at all
 * without a thread). A reply not announced yet becomes a row in the bell
 * (notices.ts, kind `reply`; the row opens the chat) and a toast - once per
 * reply. With the chat open on that thread the dialog shows it instead.
 *
 * The dialog's code (and the seed-phrase word list it checks against) loads on
 * the first open, not with the app.
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { pushNotice } from '../notices';
import { notify } from '../toast';
import { OPEN_FEEDBACK_EVENT, type OpenFeedback } from './FeedbackButton';
import { FeedbackMenu } from './FeedbackMenu';
import { REPLY_EVENT, markNotified, pollThreads, threads, unannounced } from './threads';

const FeedbackDialog = lazy(() => import('./FeedbackDialog').then((m) => ({ default: m.FeedbackDialog })));

export const POLL_MS = 60_000;

export function FeedbackHost() {
  const [open, setOpen] = useState<OpenFeedback | null>(null);
  const [mounted, setMounted] = useState(false);
  const openRef = useRef<OpenFeedback | null>(null);
  const activeThread = useRef<string | null>(null);
  openRef.current = open;

  useEffect(() => {
    const on = (e: Event) => {
      setMounted(true);
      setOpen({ ...((e as CustomEvent<OpenFeedback>).detail ?? {}) });
    };
    window.addEventListener(OPEN_FEEDBACK_EVENT, on);
    return () => window.removeEventListener(OPEN_FEEDBACK_EVENT, on);
  }, []);

  const check = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;
    const list = threads();
    if (!list.length) return;
    const counts = await pollThreads(list.map((t) => t.token));
    if (!counts) return;
    for (const r of unannounced(list, counts)) {
      markNotified(r.token, r.owner);
      if (openRef.current && activeThread.current === r.token) {
        window.dispatchEvent(new CustomEvent(REPLY_EVENT, { detail: r.token }));
        continue;
      }
      pushNotice({
        id: `feedback:${r.token.slice(0, 10)}`,
        kind: 'reply',
        title: 'The ValueDesk team replied',
        body: r.fresh > 1 ? `${r.fresh} new replies to your feedback - open the chat.` : 'A new reply to your feedback - open the chat.',
        important: true,
        ref: r.token,
      });
      notify('info', 'The ValueDesk team replied to your feedback - it is in the bell.');
    }
  }, []);

  useEffect(() => {
    void check();
    const t = window.setInterval(() => void check(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [check]);

  return (
    <>
      <FeedbackMenu />
      {mounted && (
        <Suspense fallback={null}>
          <FeedbackDialog
            open={!!open}
            request={open}
            onThread={(token) => { activeThread.current = token; }}
            onClose={() => { setOpen(null); activeThread.current = null; }}
          />
        </Suspense>
      )}
    </>
  );
}
