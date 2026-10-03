// A node:test reporter that prints one JSON line per test event, so the guide
// can show live pass/fail counts and name what failed without parsing prose.
// Used as:  node --test --test-reporter <this file's URL> --test-reporter-destination stdout
// (apps/web/e2e/guide/suites.ts reads the lines). Plain JavaScript on purpose:
// node loads a reporter before any TypeScript loader matters.
export default async function* guideReporter(source) {
  for await (const event of source) {
    const d = event.data ?? {};
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const err = d.details?.error;
      yield `${JSON.stringify({
        t: event.type === 'test:pass' ? 'pass' : 'fail',
        name: d.name,
        nesting: d.nesting,
        kind: d.details?.type ?? 'test',
        skip: d.skip !== undefined,
        todo: d.todo !== undefined,
        ms: d.details?.duration_ms,
        file: d.file,
        ...(event.type === 'test:fail' ? { err: String(err?.cause?.message ?? err?.message ?? err ?? '').slice(0, 600) } : {}),
      })}\n`;
    } else if (event.type === 'test:stderr') {
      // A test file that cannot even load fails as "test failed"; the reason is in its stderr.
      const line = String(d.message ?? '').split(/\r?\n/).find((l) => /^\s*[A-Za-z]*Error\b[^:\n]*:/.test(l));
      if (line && d.file) yield `${JSON.stringify({ t: 'stderr', file: d.file, error: line.trim().slice(0, 300) })}\n`;
    } else if (event.type === 'test:diagnostic') {
      yield `${JSON.stringify({ t: 'diag', message: d.message, nesting: d.nesting })}\n`;
    } else if (event.type === 'test:summary' && d.file === undefined) {
      yield `${JSON.stringify({ t: 'summary', counts: d.counts, success: d.success })}\n`;
    }
  }
}
