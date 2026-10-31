/**
 * Never a blank page. Whatever throws while the suite renders - or before it could
 * render at all - shows a card with what broke and where, with Reload and Sign out,
 * and is sent once to the server's audit log (POST /api/admin/page-error, the
 * session's; routes/admin.ts) so the cause can be read there.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { call, saveSession } from './api';
import { BUILD_ID as BUILD } from '../buildInfo';

const reported = new Set<string>();

/** Send one error to the audit log; each message once per page load. Never throws. */
export function reportPageError(e: unknown, where: string): void {
  const err = e instanceof Error ? e : new Error(String(e));
  const key = `${err.name}:${err.message}`;
  if (reported.has(key)) return;
  reported.add(key);
  const payload = {
    message: `${err.name}: ${err.message}`.slice(0, 400),
    stack: (err.stack ?? '').split('\n').slice(0, 12).join('\n').slice(0, 1800),
    where: where.slice(0, 400),
    route: location.hash.slice(0, 80),
    build: BUILD,
    browser: navigator.userAgent.slice(0, 200),
  };
  void call('page-error', payload).catch(() => null);
}

export function CrashCard({ error, where }: { error: unknown; where?: string }) {
  const err = error instanceof Error ? error : new Error(String(error));
  return (
    <div className="st dv-page dv-crash">
      <article className="st-card dv-card--narrow">
        <header className="st-hero is-down">
          <svg className="st-hero__icon" viewBox="0 0 20 20" width="36" height="36" aria-hidden="true">
            <circle className="st-hero__shape" cx="10" cy="10" r="8.6" />
            <path className="st-hero__sign" d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" fill="none" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <div className="st-hero__text">
            <h1 className="st-hero__title">This page broke</h1>
            <p className="st-hero__line">It was sent to the audit log. Reload, or sign out and in again.</p>
          </div>
        </header>
        <section className="dv-section">
          <p className="dv-crash__msg">{err.name}: {err.message}</p>
          {where && <pre className="dv-json">{where.trim()}</pre>}
          {err.stack && <details className="dv-details"><summary>Stack</summary><pre className="dv-json">{err.stack}</pre></details>}
          <p className="st-ms">Build {BUILD} · {location.hash || '#/overview'}</p>
          <div className="dv-row">
            <button type="button" className="dv-btn dv-btn--primary" onClick={() => location.reload()}>Reload</button>
            <button type="button" className="dv-btn" onClick={() => { saveSession(null); location.hash = ''; location.reload(); }}>Sign out</button>
          </div>
        </section>
      </article>
    </div>
  );
}

export class AdminBoundary extends Component<{ children: ReactNode }, { error: unknown; where: string }> {
  state = { error: null as unknown, where: '' };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const where = info.componentStack ?? '';
    this.setState({ where });
    reportPageError(error, `render${where.split('\n').slice(0, 6).join(' <')}`);
  }

  render() {
    if (this.state.error) return <div className="dv-root"><main className="dv-main"><CrashCard error={this.state.error} where={this.state.where} /></main></div>;
    return this.props.children;
  }
}
