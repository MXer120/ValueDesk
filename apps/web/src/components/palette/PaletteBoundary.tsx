/**
 * Error boundary around the open palette.
 *
 * The palette is mounted at the top of App, outside every panel's own
 * boundary, so without this a throw anywhere inside it - a malformed answer, or
 * a hot reload that changes a hook's shape while it is open - unmounts the
 * WHOLE app and leaves a blank page. Here it only replaces the dialog.
 *
 * SELF-HEALING. The first crash remounts the dialog on its own once, a moment
 * later (a hot-reload hook mismatch is gone on a fresh mount); a second crash
 * within AUTO_RETRY_WINDOW_MS stays on the fallback ("Search couldn't load."
 * with Retry / Close), so a real bug cannot spin in a remount loop.
 */
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { stoppedWorking } from '../LoadFailed';

const AUTO_RETRY_DELAY_MS = 250;
const AUTO_RETRY_WINDOW_MS = 10_000;

interface Props {
  onClose: () => void;
  /** The palette is animating out: the fallback just disappears. */
  closing?: boolean;
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Bumped to remount the dialog from scratch. */
  generation: number;
}

export class PaletteBoundary extends Component<Props, State> {
  state: State = { error: null, generation: 0 };
  private lastAutoRetry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[search palette] crashed', error, info.componentStack);
    const now = Date.now();
    if (now - this.lastAutoRetry > AUTO_RETRY_WINDOW_MS) {
      this.lastAutoRetry = now;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.reload(), AUTO_RETRY_DELAY_MS);
    }
  }

  componentWillUnmount(): void {
    clearTimeout(this.timer);
  }

  private reload = (): void => {
    this.setState((s) => ({ error: null, generation: s.generation + 1 }));
  };

  render(): ReactNode {
    const { error, generation } = this.state;
    if (!error) return <Fragment key={generation}>{this.props.children}</Fragment>;
    if (this.props.closing) return null;
    // Same layer / scrim / dialog structure as the palette itself (see CommandPalette.css).
    return (
      <div className="cp-layer">
        <div className="cp-scrim" aria-hidden="true" onMouseDown={() => this.props.onClose()} />
        <div
          className="cp cp--crashed"
          role="alertdialog"
          aria-modal="true"
          aria-label="Search failed"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') this.props.onClose();
          }}
        >
          <p className="cp-empty cp-empty--warn">{stoppedWorking('Search')}</p>
          <div className="cp-crashed__actions">
            <button type="button" className="cp-textbtn" onClick={this.reload} autoFocus>Retry</button>
            <button type="button" className="cp-textbtn" onClick={this.props.onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }
}
