import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetContacts, addressKind, clearRecent, contactFor, contactProblem, groupByLetter, markUsed, recentContacts, removeContact, renameContact, saveContact, sameAddress, toggleFavorite } from './contacts';

// No localStorage under node: the store keeps contacts in memory, which is what this checks.
beforeEach(() => {
  _resetContacts();
  for (const c of [contactFor('0x4b363bfcd961eca3aa723151a7ccdab76b869bfd'), contactFor('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')]) {
    if (c) removeContact(c.id);
  }
});

test('address kinds: EVM (0x + 40 hex) and Solana (base58, 32-44), nothing else', () => {
  assert.equal(addressKind('0x4b363bfcd961eca3aa723151a7ccdab76b869bfd'), 'evm');
  assert.equal(addressKind('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), 'solana');
  assert.equal(addressKind('0x123'), null);
  assert.equal(addressKind('hello world'), null);
});

test('a contact needs a name and a valid address - a mistyped EVM checksum is refused', () => {
  assert.match(contactProblem('', '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd') ?? '', /name/);
  assert.match(contactProblem('Bob', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD') ?? '', /checksum/);
  assert.match(contactProblem('Bob', 'not an address') ?? '', /EVM|Solana/);
  assert.equal(contactProblem('Bob', '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd'), null);
});

test('saving the same address again renames it instead of duplicating; EVM case does not matter', () => {
  const a = saveContact('Ledger', '0x4b363bfcd961eca3aa723151a7ccdab76b869bfd');
  const b = saveContact('Cold wallet', '0x4B363BFCD961ECA3AA723151A7CCDAB76B869BFD'.toLowerCase());
  assert.equal(a.id, b.id);
  assert.equal(contactFor('0x4b363bfcd961eca3aa723151a7ccdab76b869bfd')?.name, 'Cold wallet');
  assert.ok(sameAddress('0xABCDEF0000000000000000000000000000000001', '0xabcdef0000000000000000000000000000000001'));
  assert.ok(!sameAddress('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', '7xkxtg2cw87d97txjsdpbd5jbkhetqa83tzrujosgasu'), 'Solana is case-sensitive');
});

test('rename and delete', () => {
  const c = saveContact('Friend', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
  assert.equal(c.kind, 'solana');
  renameContact(c.id, 'Alice');
  assert.equal(contactFor(c.address)?.name, 'Alice');
  removeContact(c.id);
  assert.equal(contactFor(c.address), undefined);
});

const A1 = '0x1111111111111111111111111111111111111111';
const A2 = '0x2222222222222222222222222222222222222222';
const A3 = '0x3333333333333333333333333333333333333333';
const A4 = '0x4444444444444444444444444444444444444444';

test('Recent: added or used, newest first; favourites (listed above) and cleared ones left out; a cleared one stays saved and returns when used', () => {
  const realNow = Date.now;
  let t = 1_000;
  Date.now = () => ++t;
  try {
    const bob = saveContact('Bob', A1);
    const amy = saveContact('amy', A2);
    const zed = saveContact('Zed', A3);
    markUsed(A1);
    toggleFavorite(zed.id);
    const all = () => [bob, amy, zed].map((c) => contactFor(c.address)!);
    assert.deepEqual(recentContacts(all()).map((c) => c.name), ['Bob', 'amy']);
    clearRecent([bob.id]);
    assert.deepEqual(recentContacts(all()).map((c) => c.name), ['amy']);
    assert.ok(contactFor(A1), 'still saved');
    markUsed(A1);
    assert.deepEqual(recentContacts(all()).map((c) => c.name), ['Bob', 'amy']);
    clearRecent([bob.id, amy.id]);
    assert.deepEqual(recentContacts(all()), []);
  } finally {
    Date.now = realNow;
    for (const a of [A1, A2, A3]) removeContact(contactFor(a)!.id);
  }
});

test('View all: A-Z, one group per first letter that exists, case-insensitive, "#" last', () => {
  saveContact('bob', A1);
  saveContact('Alice', A2);
  saveContact('Ben', A3);
  saveContact('1inch', A4);
  try {
    const groups = groupByLetter([A1, A2, A3, A4].map((a) => contactFor(a)!));
    assert.deepEqual(groups.map((g) => [g.letter, g.contacts.map((c) => c.name)]), [['A', ['Alice']], ['B', ['Ben', 'bob']], ['#', ['1inch']]]);
  } finally {
    for (const a of [A1, A2, A3, A4]) removeContact(contactFor(a)!.id);
  }
});
