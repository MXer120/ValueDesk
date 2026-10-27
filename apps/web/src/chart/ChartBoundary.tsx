/**
 * The chart's own error boundary.
 *
 * The dashboard already guards every panel, but on a phone the chart is one
 * page of the order-book panel's carousel, so a chart crash there took the
 * book and the trades down with it. This keeps a failure inside the chart
 * card: the console gets an error with the component stack, the card says only
 * "Chart couldn't load." in the same styles as the feed's own error card, and
 * Retry mounts the chart afresh (a new klinecharts instance, a fresh load).
 */
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { logger } from '../log';
import { stoppedWorking } from '../components/LoadFailed';
import { reportBoundaryError } from '../errorReport';

const log = logger('chart');

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Bumped by Retry: a new key remounts everything below. */
  mount: number;
}

export class ChartBoundary extends Component<Props, State> {
  state: State = { error: null, mount: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error('the chart crashed; showing its error card', {
      error,
      componentStack: info.componentStack?.split('\n').slice(0, 10).join('\n'),
    });
    reportBoundaryError('Chart', error);
  }

  private retry = () => {
    log.info('chart remounted after a crash');
    this.setState((s) => ({ error: null, mount: s.mount + 1 }));
  };

  render(): ReactNode {
    const { error, mount } = this.state;
    if (!error) return <Fragment key={mount}>{this.props.children}</Fragment>;
    return (
      <section className="panel chart kc-panel kc-crashed">
        <div className="kc-feed-mask" role="alert">
          <div className="kc-feed-card boxed">
            <div className="kc-feed-title">{stoppedWorking('Chart')}</div>
            <div className="kc-feed-actions">
              <button type="button" className="kc-feed-retry" onClick={this.retry}>
                Retry
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }
}
