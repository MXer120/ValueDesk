#!/usr/bin/env node
// Storage-layout guard for the ValuescanCopyTrading UUPS implementation (spec §10.3).
//
// All state lives in one ERC-7201 namespace struct, `ValuescanCopyTrading.CopyTradingStorage`. A namespaced struct is
// not a state variable, so the compiler reports its layout only through the harness
// `test/upgrade/StorageLayoutHarness.sol`, whose artifact this script reads (Foundry writes `storageLayout` because
// foundry.toml has `extra_output = ["storageLayout"]`).
//
// Usage, from contracts/ after `forge build`:
//   node tools/storage-layout.mjs check      compare the build with the committed snapshot; exit 1 on any
//                                            incompatible change (the default command)
//   node tools/storage-layout.mjs update     rewrite the snapshot; refused unless `check` passes (--force overrides,
//                                            which is only ever right before the first deployment)
//   node tools/storage-layout.mjs selftest   prove the checker rejects every incompatible edit and accepts appends
//
// Rules (old = snapshot, new = build), for the root struct and every struct reachable from it:
//   - every old struct still exists (by its label);
//   - every old member keeps its index, name, slot, offset and type; new members may only be appended;
//   - a struct that grows must not be an array element (the stride would change); a struct stored inline in another
//     struct may grow only if it is that struct's last member (otherwise the members after it move, which the
//     member rule reports on the container);
//   - the namespace id and the STORAGE_LOCATION constant in the source are unchanged;
//   - every enum stored anywhere in the namespace (audit SEC-01) keeps its members in order: the compiler's layout
//     describes an enum only by its name and size, so the members come from the enum definitions in src/. Members
//     may only be appended; inserting, removing, reordering or renaming one changes what every stored ordinal means.
// No dependencies; Node 18+.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = path.join(ROOT, 'out', 'StorageLayoutHarness.sol', 'CopyTradingStorageLayoutHarness.json');
const SNAPSHOT = path.join(ROOT, 'storage-layout', 'ValuescanCopyTrading.json');
const SOURCE = path.join(ROOT, 'src', 'ValuescanCopyTrading.sol');
const SRC_DIR = path.join(ROOT, 'src');

/** Solidity source without comments (string literals kept), so that commented-out code is never parsed. */
function stripComments(code) {
  let out = '';
  for (let i = 0; i < code.length; ) {
    const c = code[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
    } else if (code.startsWith('//', i)) {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Every enum defined in `files`, as { 'enum Parent.Name': [member, ...] } (the storage layout's label format). */
export function enumDefinitions(files) {
  const enums = {};
  for (const file of files) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const scopes = [];
    const decl = /\b(?:contract|interface|library)\s+(\w+)[^{;]*\{/g;
    for (let m; (m = decl.exec(code)); ) {
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < code.length; end++) {
        if (code[end] === '{') depth++;
        else if (code[end] === '}' && --depth === 0) break;
      }
      scopes.push({ name: m[1], start: m.index, end });
    }
    const en = /\benum\s+(\w+)\s*\{([^}]*)\}/g;
    for (let m; (m = en.exec(code)); ) {
      const parent = scopes.filter((sc) => sc.start < m.index && m.index < sc.end).pop();
      const label = `enum ${parent ? `${parent.name}.` : ''}${m[1]}`;
      if (enums[label]) throw new Error(`${label} is defined twice`);
      enums[label] = m[2].split(',').map((x) => x.trim()).filter(Boolean);
    }
  }
  return enums;
}

function solidityFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? solidityFiles(p) : e.name.endsWith('.sol') ? [p] : [];
  });
}

/** Reads the compiler layout of the harness and reduces it to a stable, id-free description. */
function currentLayout() {
  if (!fs.existsSync(ARTIFACT)) {
    console.error(`missing ${path.relative(ROOT, ARTIFACT)}: run \`forge build\` first`);
    process.exit(2);
  }
  const { storageLayout } = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  if (!storageLayout || !storageLayout.types) {
    console.error('the artifact has no storageLayout: keep extra_output = ["storageLayout"] in foundry.toml');
    process.exit(2);
  }
  const src = fs.readFileSync(SOURCE, 'utf8');
  const ns = /@custom:storage-location\s+(erc7201:[\w.]+)/.exec(src);
  const loc = /STORAGE_LOCATION\s*=\s*(0x[0-9a-fA-F]{64})/.exec(src);
  return normalize(
    storageLayout,
    ns ? ns[1] : null,
    loc ? loc[1].toLowerCase() : null,
    enumDefinitions(solidityFiles(SRC_DIR)),
  );
}

function normalize(layout, namespace, location, enumDefs) {
  const types = layout.types;
  const rootVar = layout.storage.find((v) => v.label === '$');
  const structs = {};
  const arrayBases = new Set();
  const enums = {};
  const visit = (typeId) => {
    const t = types[typeId];
    if (!t) return;
    if (t.label.startsWith('enum ')) {
      if (!enumDefs[t.label]) throw new Error(`stored ${t.label}: no definition found under src/`);
      enums[t.label] = enumDefs[t.label];
    } else if (t.encoding === 'mapping') {
      visit(t.key);
      visit(t.value);
    } else if (t.encoding === 'dynamic_array' || typeId.startsWith('t_array(')) {
      if (types[t.base]?.members) arrayBases.add(types[t.base].label);
      visit(t.base);
    } else if (t.members && !structs[t.label]) {
      structs[t.label] = {
        numberOfBytes: t.numberOfBytes,
        members: t.members.map((m) => ({
          label: m.label,
          slot: m.slot,
          offset: m.offset,
          type: types[m.type].label,
          numberOfBytes: types[m.type].numberOfBytes,
        })),
      };
      for (const m of t.members) visit(m.type);
    }
  };
  visit(rootVar.type);
  return {
    contract: 'ValuescanCopyTrading',
    namespace,
    location,
    root: types[rootVar.type].label,
    arrayElementStructs: [...arrayBases].sort(),
    structs: Object.fromEntries(Object.keys(structs).sort().map((k) => [k, structs[k]])),
    enums: Object.fromEntries(Object.keys(enums).sort().map((k) => [k, enums[k]])),
  };
}

/** Returns the list of incompatibilities between `old` (snapshot) and `cur` (build). Empty means compatible. */
export function compare(old, cur) {
  const errors = [];
  if (old.namespace !== cur.namespace) errors.push(`namespace changed: ${old.namespace} -> ${cur.namespace}`);
  if (old.location !== cur.location) errors.push(`STORAGE_LOCATION changed: ${old.location} -> ${cur.location}`);
  if (old.root !== cur.root) errors.push(`root struct changed: ${old.root} -> ${cur.root}`);
  for (const [label, o] of Object.entries(old.structs)) {
    const n = cur.structs[label];
    if (!n) {
      errors.push(`${label}: removed or renamed`);
      continue;
    }
    if (n.members.length < o.members.length) {
      errors.push(`${label}: ${o.members.length - n.members.length} member(s) removed`);
    }
    o.members.forEach((om, i) => {
      const nm = n.members[i];
      if (!nm) return;
      for (const k of ['label', 'slot', 'offset', 'type']) {
        if (om[k] !== nm[k]) {
          errors.push(`${label}.${om.label} (member ${i}): ${k} ${JSON.stringify(om[k])} -> ${JSON.stringify(nm[k])}`);
        }
      }
    });
    if (Number(n.numberOfBytes) !== Number(o.numberOfBytes)) {
      if (cur.arrayElementStructs.includes(label)) errors.push(`${label}: array element grew (stride changes)`);
      for (const [cLabel, c] of Object.entries(cur.structs)) {
        const idx = c.members.findIndex((m) => m.type === label);
        if (idx !== -1 && idx !== c.members.length - 1) {
          errors.push(`${label}: grew while stored inline in ${cLabel} before its last member`);
        }
      }
    }
  }
  // Enum members (SEC-01): the old list must be a prefix of the new one. A snapshot without `enums` predates the rule.
  for (const [label, oldMembers] of Object.entries(old.enums ?? {})) {
    const newMembers = cur.enums?.[label];
    if (!newMembers) {
      errors.push(`${label}: removed or renamed`);
      continue;
    }
    oldMembers.forEach((m, i) => {
      if (newMembers[i] !== m) {
        errors.push(
          `${label}: member ${i} ${JSON.stringify(m)} -> ${JSON.stringify(newMembers[i] ?? null)} ` +
            '(enum members may only be appended)',
        );
      }
    });
  }
  return errors;
}

function check() {
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(`missing ${path.relative(ROOT, SNAPSHOT)}: run \`node tools/storage-layout.mjs update\``);
    process.exit(2);
  }
  const old = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const cur = currentLayout();
  const errors = compare(old, cur);
  if (errors.length) {
    console.error('INCOMPATIBLE storage layout change (spec §10.3):');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const added = Object.keys(cur.structs).filter((k) => !old.structs[k]);
  const grown = Object.keys(old.structs).filter((k) => cur.structs[k].members.length > old.structs[k].members.length);
  const enumsOld = old.enums ?? {};
  added.push(...Object.keys(cur.enums).filter((k) => !enumsOld[k]));
  grown.push(...Object.keys(enumsOld).filter((k) => cur.enums[k].length > enumsOld[k].length));
  if (!old.enums) console.log('note: the snapshot predates the enum rule; run `update` to record the enum members');
  console.log(
    `storage layout OK: ${Object.keys(old.structs).length} structs and ${Object.keys(enumsOld).length} enums ` +
      'compatible with the snapshot' +
      (added.length || grown.length ? ` (appended: ${[...grown, ...added].join(', ')}; run \`update\` to record)` : ''),
  );
}

function update(force) {
  const cur = currentLayout();
  if (fs.existsSync(SNAPSHOT) && !force) {
    const errors = compare(JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')), cur);
    if (errors.length) {
      console.error('refusing to overwrite the snapshot with an incompatible layout:');
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
  }
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, JSON.stringify(cur, null, 2) + '\n');
  console.log(`wrote ${path.relative(ROOT, SNAPSHOT)}`);
}

function selftest() {
  const base = fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) : currentLayout();
  if (!base.enums || !base.enums['enum IValuescanCopyTrading.Status']) {
    console.error('the snapshot has no enum members: run `node tools/storage-layout.mjs update` first');
    process.exit(2);
  }
  // The enum parser itself, on source text: nested scopes, comments, file-level enums.
  const tmp = path.join(ROOT, 'cache', 'storage-layout-selftest.sol');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, [
    'enum Top { A, B }',
    'interface I { /* enum Fake { X } */ enum S { NONE, ACTIVE, // PAUSED,',
    '  STOPPED } struct T { S s; } }',
    'contract K is I { function f() external {} enum M { P, Q } }',
  ].join('\n'));
  const parsed = enumDefinitions([tmp]);
  fs.rmSync(tmp);
  const expected = { 'enum Top': ['A', 'B'], 'enum I.S': ['NONE', 'ACTIVE', 'STOPPED'], 'enum K.M': ['P', 'Q'] };
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    console.error(`FAIL  enum parser: ${JSON.stringify(parsed)}`);
    process.exit(1);
  }
  console.log('PASS  enum parser: scopes, comments and file-level enums');
  const S = 'struct IValuescanCopyTrading.Subscription';
  const R = base.root;
  const clone = () => JSON.parse(JSON.stringify(base));
  const lastSlot = (s) => Math.max(...s.members.map((m) => Number(m.slot)));
  const cases = [
    ['identical', (l) => l, true],
    ['append a member to Subscription', (l) => {
      const s = l.structs[S];
      s.members.push({ label: 'newField', slot: String(lastSlot(s) + 1), offset: 0, type: 'uint256', numberOfBytes: '32' });
      s.numberOfBytes = String(Number(s.numberOfBytes) + 32);
    }, true],
    ['append a member to the namespace', (l) => {
      const s = l.structs[R];
      s.members.push({ label: 'newIndex', slot: String(lastSlot(s) + 1), offset: 0, type: 'mapping(address => uint256)', numberOfBytes: '32' });
    }, true],
    ['add a new struct type', (l) => {
      l.structs['struct X.New'] = { numberOfBytes: '32', members: [{ label: 'a', slot: '0', offset: 0, type: 'uint256', numberOfBytes: '32' }] };
    }, true],
    ['reorder two members', (l) => {
      const m = l.structs[S].members;
      [m[1].label, m[2].label] = [m[2].label, m[1].label];
    }, false],
    ['retype a member (uint64 -> uint128)', (l) => {
      const m = l.structs[S].members.find((x) => x.type === 'uint64');
      m.type = 'uint128';
    }, false],
    ['rename a member', (l) => {
      l.structs[S].members[0].label = 'owner';
    }, false],
    ['remove the last member of the namespace', (l) => {
      l.structs[R].members.pop();
    }, false],
    ['insert a member in the middle (shift)', (l) => {
      const s = l.structs[R];
      for (let i = 3; i < s.members.length; i++) s.members[i].slot = String(Number(s.members[i].slot) + 1);
    }, false],
    ['change a packing offset', (l) => {
      l.structs[S].members[1].offset += 1;
    }, false],
    ['remove a struct', (l) => {
      delete l.structs['struct IValuescanCopyTrading.Commitment'];
    }, false],
    ['move STORAGE_LOCATION', (l) => {
      l.location = '0x' + '11'.repeat(32);
    }, false],
    ['append an enum member (Status)', (l) => {
      l.enums['enum IValuescanCopyTrading.Status'].push('HALTED');
    }, true],
    ['insert an enum member (Status: HALTED before STOPPED)', (l) => {
      l.enums['enum IValuescanCopyTrading.Status'].splice(3, 0, 'HALTED');
    }, false],
    ['reorder enum members (SymbolMode: DENY before ALLOW)', (l) => {
      const m = l.enums['enum IValuescanCopyTrading.SymbolMode'];
      [m[1], m[2]] = [m[2], m[1]];
    }, false],
    ['rename an enum member (MarketScope)', (l) => {
      l.enums['enum IValuescanCopyTrading.MarketScope'][1] = 'PERP';
    }, false],
    ['remove the last enum member (SizingMode)', (l) => {
      l.enums['enum IValuescanCopyTrading.SizingMode'].pop();
    }, false],
    ['remove a stored enum', (l) => {
      delete l.enums['enum IValuescanCopyTrading.Status'];
    }, false],
    ['grow an inline struct that is not the last member', (l) => {
      const s = l.structs[R];
      const bt = s.members.findIndex((m) => m.type === 'struct IValuescanCopyTrading.BuilderTerms');
      const [m] = s.members.splice(bt, 1);
      s.members.splice(0, 0, m); // pretend it sat first...
      l.structs['struct IValuescanCopyTrading.BuilderTerms'].numberOfBytes = '64'; // ...and grew
    }, false],
  ];
  let failures = 0;
  for (const [name, mutate, expectOk] of cases) {
    const cur = clone();
    mutate(cur);
    const baseForCase = name === 'grow an inline struct that is not the last member' ? (() => {
      // The snapshot must describe the same member order for this case, so that only the growth differs.
      const b = clone();
      const s = b.structs[R];
      const bt = s.members.findIndex((m) => m.type === 'struct IValuescanCopyTrading.BuilderTerms');
      const [m] = s.members.splice(bt, 1);
      s.members.splice(0, 0, m);
      return b;
    })() : base;
    const errors = compare(baseForCase, cur);
    const ok = errors.length === 0;
    const pass = ok === expectOk;
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${ok ? 'accepted' : `rejected (${errors[0]})`}`);
  }
  if (failures) {
    console.error(`${failures} selftest case(s) failed`);
    process.exit(1);
  }
  console.log('selftest OK');
}

const [cmd = 'check', flag] = process.argv.slice(2);
if (cmd === 'check') check();
else if (cmd === 'update') update(flag === '--force');
else if (cmd === 'selftest') selftest();
else {
  console.error('usage: node tools/storage-layout.mjs [check|update [--force]|selftest]');
  process.exit(2);
}
