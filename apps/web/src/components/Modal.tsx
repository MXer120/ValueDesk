/**
 * Accessible modal primitive, and a promise-based replacement for the native
 * `confirm()` calls scattered through the app.
 *
 * Why this exists rather than keeping `window.confirm`: the highest-stakes
 * dialogs in this app (withdraw, cancel-all, turning off trading, placing a
 * mainnet order) were all native dialogs. Those cannot be styled, cannot show
 * the numbers that make the decision reviewable, ignore the blur backdrop, and
 * ignore `prefers-reduced-motion`. A withdrawal confirmation that cannot show
 * you the amount and destination is not really a confirmation.
 *
 * Accessibility notes, because a trading modal that traps a keyboard user is a
 * real problem:
 *  - focus moves into the dialog on open and is restored to the invoking
 *    element on close;
 *  - Tab/Shift+Tab cycle within the dialog (focus trap);
 *  - Escape closes, from anywhere inside - bound at document level, not to one
 *    input, which is the bug the symbol-search modal originally had;
 *  - the dialog is labelled by its own title element.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from './motion';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Widens the dialog for content-heavy reviews. */
  size?: 'sm' | 'md' | 'lg';
  /** Set false for destructive confirmations that must be dismissed deliberately. */
  dismissOnBackdrop?: boolean;
  /** Extra class on the dialog (a styled variant, e.g. the deposit/withdraw sheets). */
  className?: string;
  /** Shows a back arrow before the title (multi-step dialogs). */
  onBack?: () => void;
  /**
   * A panel beside the dialog (the Withdraw sheet's address book). Passing the
   * prop at all - null included - puts dialog and panel in one row that stays
   * centred: the panel slides open to the right and the pair re-centres,
   * without the dialog itself changing. Keyboard focus cycles through both.
   */
  aside?: ReactNode;
  /**
   * A panel under the dialog (the Transfer sheet's status). The dialog keeps
   * its size; the pair grows downward. `dockOpen` squares the shared bottom
   * corners. Does not change `aside`. Keyboard focus cycles through both.
   */
  dock?: ReactNode;
  dockOpen?: boolean;
}

export function Modal({
  open, title, onClose, children, footer, size = 'sm', dismissOnBackdrop = true, className, onBack, aside,
  dock, dockOpen = false,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLDivElement>(null);
  const withAside = aside !== undefined;
  /* The panel keeps its last content while it slides shut, so closing animates
     the panel rather than an empty box; it is inert from the moment it closes. */
  const lastAside = useRef<ReactNode>(null);
  if (aside) lastAside.current = aside;
  const shownAside = aside || lastAside.current;
  useEffect(() => {
    if (asideRef.current) asideRef.current.inert = !aside;
  }, [aside]);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    restoreTo.current = prev;
    // The dev dock stays the focused surface when it opened this sheet, so the
    // next control in the dock can be used without clicking back into it.
    if (prev?.closest('.devp')) {
      return () => {
        const now = document.activeElement as HTMLElement | null;
        if (now?.closest('.devp')) return;
        restoreTo.current?.focus?.();
      };
    }

    const node = dialogRef.current;
    // Prefer the first real control; fall back to the dialog itself so focus
    // never stays behind on the page underneath.
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();

    return () => {
      const now = document.activeElement as HTMLElement | null;
      if (now?.closest('.devp')) return;
      restoreTo.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const node = rowRef.current ?? stackRef.current ?? dialogRef.current;
      if (!node) return;
      // The dev dock stays in the tab cycle while a sheet is open, so it can
      // be used without closing the thing it opened.
      const dock = document.querySelector<HTMLElement>('.devp');
      // `inert` is how a closed drawer (and the address-book aside) leaves the
      // tab cycle. offsetParent alone still sees controls inside a 0-height clip.
      const items = [
        ...node.querySelectorAll<HTMLElement>(FOCUSABLE),
        ...(dock ? dock.querySelectorAll<HTMLElement>(FOCUSABLE) : []),
      ].filter((el) => el.offsetParent !== null && !el.closest('[inert]'));
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      // Wrap manually; otherwise Tab walks out into the page behind the modal.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  // Closing plays the exit (motion.css) before the sheet unmounts.
  const presence = usePresence(open, 220);
  if (!presence.mounted) return null;

  /*
   * Portalled to <body>, and this is load-bearing rather than tidiness.
   *
   * `.modal-scrim` is `position: fixed; inset: 0`, but a fixed element is
   * positioned against the nearest ancestor carrying a transform/filter/
   * will-change - not the viewport. The trade screen is a react-grid-layout,
   * and every panel is placed with `transform: translate(...)`. Rendered in
   * place, the order-entry review was therefore clipped to the order-entry
   * panel: a 620px dialog squeezed into a ~330px column with its exit table
   * cut off mid-number. Verified in a real browser, not reasoned about.
   */
  const withDock = dock !== undefined;
  const dialog = (
    <div
      ref={dialogRef}
      className={`modal modal-${size}${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      tabIndex={-1}
    >
      <div className="modal-head">
        {onBack && (
          <button type="button" className="modal-back" onClick={onBack} aria-label="Back">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
        <h2 id="modal-title">{title}</h2>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  );

  const framed = withDock ? (
    <div
      ref={stackRef}
      className={`modal-stack modal-${size}${className ? ` ${className}` : ''}${dockOpen ? ' has-dock' : ''}`}
    >
      {dialog}
      <div className="modal-dock">{dock}</div>
    </div>
  ) : dialog;

  return createPortal(
    <div
      className={`modal-scrim${presence.closing ? ' is-closing' : ''}`}
      onMouseDown={(e) => {
        if (open && dismissOnBackdrop && e.target === e.currentTarget) onClose();
      }}
      onAnimationEnd={(e) => {
        if (presence.closing && e.animationName === 'mo-scrim-out') presence.done();
      }}
    >
      {withAside ? (
        <div ref={rowRef} className={`modal-row${aside ? ' has-aside' : ''}`}>
          {framed}
          <div
            ref={asideRef}
            className={`modal-aside${aside ? ' is-open' : ''}`}
            aria-hidden={!aside}
            onTransitionEnd={(e) => {
              if (!aside && e.target === e.currentTarget) lastAside.current = null;
            }}
          >
            {shownAside && <div className={`modal-aside__card${className ? ` ${className}` : ''}`}>{shownAside}</div>}
          </div>
        </div>
      ) : framed}
    </div>,
    document.body,
  );
}

interface ConfirmRequest {
  title: ReactNode;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive and blocks backdrop dismissal. */
  danger?: boolean;
  size?: ModalProps['size'];
  /**
   * When set, the confirm button stays disabled until the user ticks this
   * acknowledgement.
   *
   * This exists for the case where the review itself found a hazard - a stop
   * placed beyond estimated liquidation, say. A warning the user can click past
   * with the same single motion they were already making is a warning that gets
   * clicked past. Requiring a second, separate action means the user has to
   * have read the sentence to get to the button.
   */
  requireAck?: ReactNode;
  resolve: (ok: boolean) => void;
}

export type ConfirmFn = (opts: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>;

/**
 * Drop-in async replacement for `window.confirm`, but able to render real
 * content (a review table, a liquidation warning) instead of one string.
 *
 * Usage:
 *   const { confirm, dialog } = useConfirm();
 *   if (!(await confirm({ title: 'Withdraw', body: <Review/>, danger: true }))) return;
 *   ...then render {dialog} somewhere in the component tree.
 */
export function useConfirm(): { confirm: ConfirmFn; dialog: ReactNode } {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  // Acknowledgement state lives here rather than in the body, because the
  // button it gates lives here. Reset on every open so a previous dialog's
  // tick can never pre-clear the next one's hazard.
  const [ack, setAck] = useState(false);

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        setAck(false);
        setReq({ ...opts, resolve });
      }),
    [],
  );

  const settle = useCallback(
    (ok: boolean) => {
      setReq((cur) => {
        cur?.resolve(ok);
        return null;
      });
    },
    [],
  );

  const dialog = req ? (
    <Modal
      open
      size={req.size ?? 'sm'}
      title={req.title}
      onClose={() => settle(false)}
      dismissOnBackdrop={!req.danger}
      footer={
        <>
          {req.requireAck && (
            // `margin-right: auto` inline rather than a class: `.modal-foot` is
            // right-aligned and this is the only element that ever needs to sit
            // opposite the buttons. No colour is hardcoded here.
            <label className="inline small" style={{ marginRight: 'auto', textAlign: 'left' }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              {req.requireAck}
            </label>
          )}
          <button onClick={() => settle(false)}>{req.cancelLabel ?? 'Cancel'}</button>
          <button
            className={req.danger ? 'btn-danger' : 'btn-primary'}
            disabled={Boolean(req.requireAck) && !ack}
            onClick={() => settle(true)}
          >
            {req.confirmLabel ?? 'Confirm'}
          </button>
        </>
      }
    >
      {req.body}
    </Modal>
  ) : null;

  return { confirm, dialog };
}
