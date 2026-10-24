import { test } from 'node:test';
import assert from 'node:assert/strict';
import { licenceAllowed, licenceOf, packageDirOf, renderLicences, type PackageLicence } from '../../tools/licenses.mjs';
import { LICENSES } from './licenses';

const pkg = (name: string, licence: string | null, cleared = false): PackageLicence => ({
  name,
  version: '1.0.0',
  licence,
  cleared,
  source: `https://example.org/${name}`,
  files: [{ name: 'LICENSE', text: `Copyright (c) the ${name} authors` }],
});

test('only permissive licences ship without a decision: copyleft, source-available and "see licence" stop the build', () => {
  for (const ok of ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', '0BSD', 'OFL-1.1', '(Apache-2.0 AND MIT)', '(MIT OR GPL-3.0-or-later)']) assert.ok(licenceAllowed(ok), ok);
  for (const no of ['GPL-3.0', 'AGPL-3.0-only', 'LGPL-2.1', 'BUSL-1.1', 'SSPL-1.0', 'SEE LICENSE IN LICENSE.md', 'UNLICENSED', '(MIT AND GPL-2.0)', '', null]) assert.equal(licenceAllowed(no), false, String(no));
  assert.equal(licenceOf({ license: 'MIT' }), 'MIT');
  assert.equal(licenceOf({ license: { type: 'ISC' } }), 'ISC');
  assert.equal(licenceOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }), 'MIT OR Apache-2.0');
  assert.equal(licenceOf({}), null);
});

test('a module id names its npm package (scoped, nested, Windows paths); our own code names none', () => {
  assert.deepEqual(packageDirOf('/w/node_modules/react/index.js'), { dir: '/w/node_modules/react', name: 'react' });
  assert.deepEqual(packageDirOf('C:\\w\\node_modules\\@reown\\appkit\\dist\\x.js?v=1'), { dir: 'C:/w/node_modules/@reown/appkit', name: '@reown/appkit' });
  assert.equal(packageDirOf('/w/node_modules/a/node_modules/b/lib/c.js')?.name, 'b', 'the innermost package');
  assert.equal(packageDirOf('/w/apps/web/src/App.tsx'), null);
  assert.equal(packageDirOf('\0vite/preload-helper'), null);
});

test('the file: a summary, each package with its own licence and notice texts, Reown\'s notice only where its code is in', () => {
  const text = renderLicences([pkg('react', 'MIT'), pkg('@reown/appkit', 'Reown / WalletConnect Community License', true)]);
  assert.match(text, /react@1\.0\.0 - MIT/);
  assert.match(text, /Copyright \(c\) the react authors/);
  assert.match(text, /Portions © 2025 Reown, Inc\. All Rights Reserved/);
  assert.doesNotMatch(renderLicences([pkg('ws', 'MIT')], 'the ValueDesk copier'), /Reown/);
  assert.match(renderLicences([pkg('ws', 'MIT')], 'the ValueDesk copier'), /^Third-party software in the ValueDesk copier\n\nThe ValueDesk copier contains/);
});

test('the Licences page links the generated file and carries the notices the licences ask for', () => {
  const all = JSON.stringify(LICENSES);
  assert.ok(all.includes('(/third-party-licenses.txt)'));
  assert.ok(all.includes('Portions © 2025 Reown, Inc. All Rights Reserved'));
  assert.ok(all.includes('SIL Open Font License'));
});
