/**
 * Per-panel error boundary.
 *
 * Added after an unexpected API response shape (`orders` arriving wrapped in an
 * object rather than as a bare array) threw inside one panel and blanked the
 * entire application. On a trading screen that is the worst possible failure
 * mode: the positions and open-orders panels vanish precisely when something is
 * off. Each panel is isolated so the rest of the screen keeps working.
 *
 * The fallback is the app's one generic load failure - "<name> couldn't load."
 * with Retry (LoadFailed.tsx). The crash itself goes to the console with its
 * component stack, never onto the page - and, scrubbed, to the owner as a client
 * error report (errorReport.ts) under the boundary's name.
 */
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { LoadFailed } from './LoadFailed';
import { reportBoundaryError } from '../errorReport';

interface Props {
  /** Shown in the fallback so the user knows which panel failed. */
  name: string;
  children: ReactNode;
  /** No heading over the fallback (a whole page, or a section with its own title around it). */
  bare?: boolean;
}

interface State {
  error: Error | null;
  /** Bumped by Retry: a new key remounts the panel from scratch. */
  mount: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, mount: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.name}] panel crashed`, error, info.componentStack);
    reportBoundaryError(this.props.name, error);
  }

  private retry = () => this.setState((s) => ({ error: null, mount: s.mount + 1 }));

  render(): ReactNode {
    const { error, mount } = this.state;
    if (!error) return <Fragment key={mount}>{this.props.children}</Fragment>;

    return (
      <section className="panel">
        {!this.props.bare && <h2>{this.props.name}</h2>}
        <LoadFailed what={this.props.name} onRetry={this.retry} crashed />
      </section>
    );
  }
}

/** Convenience wrapper so App stays readable. */
export const Guarded = ({ name, children, bare }: Props) => (
  <ErrorBoundary name={name} bare={bare}>{children}</ErrorBoundary>
);
