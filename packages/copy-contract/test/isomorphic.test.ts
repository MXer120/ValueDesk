/**
 * The package contract: src/ runs unchanged in the browser, a worker and Node (only @noble/*), and never sends
 * anything. tsconfig.json enforces the typings side (`types: []`, no DOM lib); this scans the source for the rest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { srcDir } from './helpers.ts';

const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
/** Source without comments and string literals, so documentation that mentions `fetch` or `node:` does not count. */
const code = (f: string): string =>
  readFileSync(join(srcDir, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "''");

test('src/ imports only relative modules and @noble/*', () => {
  assert.ok(files.length >= 14);
  for (const f of files) {
    const src = readFileSync(join(srcDir, f), 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm)) {
      const spec = m[1]!;
      assert.ok(spec.startsWith('./') || spec.startsWith('@noble/'), `${f} imports ${spec}`);
    }
  }
});

test('src/ uses no Node, DOM or network globals', () => {
  const forbidden = [/\bBuffer\b/, /\bprocess\./, /\bwindow\b/, /\bdocument\b/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\brequire\s*\(/, /\blocalStorage\b/];
  for (const f of files) {
    const c = code(f);
    for (const re of forbidden) assert.ok(!re.test(c), `${f} uses ${re}`);
  }
});

test('the package declares only @noble/* at runtime', () => {
  const pkg = JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@noble/curves', '@noble/hashes']);
});
