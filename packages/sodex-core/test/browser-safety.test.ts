/**
 * The package contract: nothing under src/ may depend on Node or on a DOM
 * global being typed. tsconfig.json (types: [], lib ES2022) enforces the type
 * side; this test enforces the source side, including things tsc cannot see
 * (a dynamic require, a stray Buffer in a comment-free expression, fetch).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { srcDir } from './fixtures.ts';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Strip comments so documentation may mention forbidden names. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const FORBIDDEN: Array<[RegExp, string]> = [
  [/from\s+['"]node:/, 'node: import'],
  [/import\(\s*['"]node:/, 'dynamic node: import'],
  [/\brequire\s*\(/, 'require()'],
  [/\bBuffer\b/, 'Buffer'],
  [/\bprocess\./, 'process'],
  [/\bfetch\s*\(/, 'fetch - this package never sends anything'],
  [/\bXMLHttpRequest\b|\bWebSocket\s*\(/, 'network I/O'],
  [/\bwindow\./, 'window'],
  [/\bdocument\./, 'document'],
  [/\beval\s*\(|new\s+Function\s*\(/, 'eval'],
];

test('src/ has no Node, DOM-global or network dependencies', () => {
  const offences: string[] = [];
  for (const f of files(srcDir)) {
    const c = code(readFileSync(f, 'utf8'));
    for (const [re, what] of FORBIDDEN) if (re.test(c)) offences.push(`${relative(srcDir, f)}: ${what}`);
  }
  assert.deepEqual(offences, []);
});

test('src/ imports only @noble/* and its own modules', () => {
  const bad: string[] = [];
  for (const f of files(srcDir)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1]!;
      if (!spec.startsWith('.') && !spec.startsWith('@noble/')) bad.push(`${relative(srcDir, f)}: ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the package entry loads and exposes the core API', async () => {
  const mod = await import('../src/index.ts');
  for (const name of [
    'signAndBuild', 'signAndBuildWithNonceManager', 'generateTradingKey', 'prepareApiKeyRegistration',
    'assembleWalletSignedRequest', 'prepareApiKeyRevocation', 'prepareBuilderFeeApproval',
    'createNonceManager', 'createMemoryNonceManager', 'perpsActions', 'spotActions', 'canonicalDecimal',
    'normaliseOrder', 'describeKeyScope', 'assertPermissionedMask', 'parseEnvelope', 'hashTypedData',
  ]) {
    assert.equal(typeof (mod as Record<string, unknown>)[name], name === 'perpsActions' || name === 'spotActions' ? 'object' : 'function', name);
  }
});
