/**
 * The feedback chat's one home in the app (App.tsx mounts it once, with the
 * connected wallet): the dialog, opened by `openFeedback()` from anywhere; the
 * right-click entry (FeedbackMenu.tsx); and the watch for the ValueDesk team's
 * replies.
 *
 * THE REPLIES. While the tab is visible, every POLL_MS and whenever it comes back
 * into view, a browser signed in with the connected wallet (session.ts) asks how
 * many replies the wallet's chat has (threads.ts pollWallet). A reply not
 * announced yet becomes a row in the bell (notices.ts, kind `reply`; the row
 * opens the chat) and a toast - once per reply. With the chat open the dialog
 * shows it instead. Without the signature nothing is asked: the server tells
 * nothing about a chat, not even a count; the bell only carries the generic
 * "sign in to see replies" row the dialog leaves after an unsigned send
 * (FeedbackDialog.tsx).
 *
 * The dialog's code (and the seed-phrase word list it checks against) loads on
 * the first open, not with the app.
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { pushNotice } from '../notices';
import { notify } from '../toast';
import type { Eip1193Provider } from '../wallet';
import { OPEN_FEEDBACK_EVENT, type OpenFeedback } from './FeedbackButton';
import { FeedbackMenu } from './FeedbackMenu';
import { connectedWallet } from './context';
import { heldSession, markSessionSeen } from './session';
import { REPLY_EVENT, pollWallet } from './threads';

const FeedbackDialog = lazy(() => import('./FeedbackDialog').then((m) => ({ default: m.FeedbackDialog })));

export const POLL_MS = 60_000;

/** What one poll found to announce: the signed-in wallet's replies not announced yet (none without a session). Exported for tests. */
export async function findNewReplies(wallet: string | null, f: typeof fetch = fetch): Promise<Array<{ ref: string; owner: number; fresh: number; mark: () => void }> | null> {
  const session = heldSession(wallet);
  if (!session) return [];
  const r = await pollWallet(session.token, f);
  if (!r) return null;
  const out: Array<{ ref: string; owner: number; fresh: number; mark: () => void }> = [];
  if (r.wallet) {
    const known = Math.max(session.notifiedOwner, session.seenOwner);
    const count = r.wallet.owner;
    if (count > known) out.push({ ref: 'wallet', owner: count, fresh: count - known, mark: () => markSessionSeen(session.owner, count, { notifiedOnly: true }) });
  }
  return out;
}

export function FeedbackHost({ address = null, provider = null }: { address?: string | null; provider?: Eip1193Provider | null } = {}) {
  const [open, setOpen] = useState<OpenFeedback | null>(null);
  const [mounted, setMounted] = useState(false);
  const openRef = useRef<OpenFeedback | null>(null);
  const activeThread = useRef<string | null>(null);
  const addressRef = useRef<string | null>(address);
  openRef.current = open;
  addressRef.current = address;

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
    const found = await findNewReplies((addressRef.current ?? connectedWallet())?.toLowerCase() ?? null);
    if (!found) return;
    for (const r of found) {
      r.mark();
      if (openRef.current && activeThread.current === r.ref) {
        window.dispatchEvent(new CustomEvent(REPLY_EVENT, { detail: r.ref }));
        continue;
      }
      pushNotice({
        id: `feedback:${r.ref === 'wallet' ? 'wallet' : r.ref.slice(0, 10)}`,
        kind: 'reply',
        title: 'The ValueDesk team replied',
        body: r.fresh > 1 ? `${r.fresh} new replies to your feedback - open the chat.` : 'A new reply to your feedback - open the chat.',
        important: true,
        ref: r.ref,
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
            address={address}
            provider={provider}
            onThread={(key) => { activeThread.current = key; }}
            onClose={() => { setOpen(null); activeThread.current = null; }}
          />
        </Suspense>
      )}
    </>
  );
}
