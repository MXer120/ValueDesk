/**
 * The keyboard: lines, the hidden key prompt, `--yes` - and child processes'
 * environments (the only way a key ever leaves the guide).
 *   npx tsx --test e2e/guide/prompt.test.ts        (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { generatePrivateKey } from 'viem/accounts';
import { KEY_ENV, childEnv, runProcess } from './proc';
import { StdinPrompter, askValue, choose, confirm, pressEnter, typeExactly, type Asker } from './prompt';
import { Stopped } from './types';
import { Output } from './ui';

type FakeStdin = PassThrough & { isTTY?: boolean; setRawMode?: (v: boolean) => void; raw: boolean[] };

function stdin(tty: boolean): FakeStdin {
  const s = new PassThrough() as FakeStdin;
  s.isTTY = tty;
  s.raw = [];
  if (tty) s.setRawMode = (v: boolean) => void s.raw.push(v);
  return s;
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function prompter(tty: boolean, clipboard?: () => string | null): { p: StdinPrompter; s: FakeStdin; shown: string[] } {
  const s = stdin(tty);
  const shown: string[] = [];
  return { p: new StdinPrompter(s as unknown as NodeJS.ReadStream, (x) => shown.push(x), clipboard ? { clipboard } : {}), s, shown };
}

// --- lines ------------------------------------------------------------------------------------

test('scripted input: the lines in order, echoed so a transcript reads like a session; then "ended"', async () => {
  const { p, s, shown } = prompter(false);
  s.write('first\r\nsecond\nlast without a newline');
  s.end();
  assert.equal(p.interactive, false);
  assert.equal(await p.ask('one? '), 'first');
  assert.equal(await p.ask('two? '), 'second');
  assert.equal(await p.ask('three? '), 'last without a newline');
  assert.equal(await p.ask('four? '), null);
  assert.deepEqual(shown, ['one? ', 'first\n', 'two? ', 'second\n', 'three? ', 'last without a newline\n', 'four? ', '(the input ended)\n']);
});

test('at a console, what was typed BEFORE a question is not an answer to it', async () => {
  const { p, s } = prompter(true);
  s.write('y\r\n'); // an Enter pressed while a suite was running
  await tick();
  const answer = p.ask('Start? ');
  await tick();
  s.write('no\r\n');
  assert.equal(await answer, 'no');
});

test('waitLine: a line typed in time, or nothing after the wait', async () => {
  const { p, s } = prompter(true);
  const waiting = p.waitLine(1000);
  s.write('q\r\n');
  assert.equal(await waiting, 'q');
  const t0 = Date.now();
  assert.equal(await p.waitLine(40), null);
  assert.ok(Date.now() - t0 >= 30);
  // After the input has ended it still waits (a wait loop must keep its pace).
  s.end();
  await tick();
  assert.equal(await p.waitLine(20), null);
});

test('Ctrl+C: an open question ends without an answer', async () => {
  const { p } = prompter(true);
  const open = p.ask('Well? ');
  p.interrupt();
  assert.equal(await open, null);
});

// --- the hidden prompt ------------------------------------------------------------------------

test('the key prompt: echo off, a star per character, nothing of the key on the screen', async () => {
  const key = generatePrivateKey(); // made for this test
  const { p, s, shown } = prompter(true);
  const typed = p.askHidden('Key: ');
  await tick();
  s.write(key.slice(0, 10)); // typed
  s.write('zz\u007f\b'); // two wrong characters, removed again (Backspace as DEL and as BS)
  s.write(`${key.slice(10)}\r\n`); // the rest, pasted with its line break
  assert.equal(await typed, key);
  assert.deepEqual(s.raw, [true, false], 'raw mode is switched on for the prompt and off again');
  const screen = shown.join('');
  assert.ok(!screen.includes(key.slice(2, 12)), 'no part of the key is ever written');
  assert.match(screen, /^Key: \*+/);
  assert.equal((screen.match(/\*/g) ?? []).length, key.length + 2);
});

test('the key prompt: a paste in one piece, bracketed-paste markers and arrow keys are not part of the key', async () => {
  const key = generatePrivateKey();
  const { p, s } = prompter(true);
  const typed = p.askHidden('Key: ');
  await tick();
  s.write(`\u001b[200~${key}\u001b[201~\u001b[A\u001b[D\r`);
  assert.equal(await typed, key);
});

test('the key prompt: the Esc key alone does not swallow the character after it', async () => {
  const key = generatePrivateKey();
  const { p, s } = prompter(true);
  const typed = p.askHidden('Key: ');
  await tick();
  s.write('\u001b'); // Esc, pressed by itself
  await tick();
  s.write(`${key}\r`);
  assert.equal(await typed, key);
});

test('the Enter that ends the key prompt never answers the NEXT question, even when its line feed arrives late', async () => {
  const key = generatePrivateKey();
  const { p, s } = prompter(true);
  const typed = p.askHidden('Key: ');
  await tick();
  s.write(`${key}\r`);
  assert.equal(await typed, key);
  const next = p.ask('Is that the wallet you mean? ');
  await tick();
  s.write('\n'); // the second half of that Enter, in a chunk of its own
  await tick();
  s.write('n\r\n');
  assert.equal(await next, 'n', 'an empty line would have taken the default');
  // Only that one line feed is dropped: an Enter typed afterwards is an answer again.
  const third = p.ask('Sure? ');
  await tick();
  s.write('\r\n');
  assert.equal(await third, '');
});

test('the key prompt: Ctrl+V in a classic console window reads the clipboard; Ctrl+U starts over', async () => {
  const key = generatePrivateKey();
  const { p, s } = prompter(true, () => `${key}\r\n`);
  const typed = p.askHidden('Key: ');
  await tick();
  s.write('wrong\u0015'); // typed something, then Ctrl+U
  s.write('\u0016'); // Ctrl+V
  s.write('\r');
  assert.equal(await typed, key);
});

test('the key prompt: Ctrl+C gives no key; the console is put back', async () => {
  const { p, s } = prompter(true);
  const typed = p.askHidden('Key: ');
  await tick();
  s.write('abc\u0003');
  assert.equal(await typed, null);
  assert.deepEqual(s.raw, [true, false]);
});

test('the key prompt with scripted input: the line is read, and never shown', async () => {
  const key = generatePrivateKey();
  const { p, s, shown } = prompter(false);
  s.write(`${key}\n`);
  assert.equal(await p.askHidden('Key: '), key);
  assert.deepEqual(shown, ['Key: ', '(hidden)\n']);
});

// --- questions and --yes ------------------------------------------------------------------------

function asker(lines: string[], auto: boolean): { a: Asker; printed: string[] } {
  const { p, s } = prompter(false);
  for (const l of lines) s.write(`${l}\n`);
  s.end();
  const printed: string[] = [];
  return { a: { out: new Output((x) => printed.push(x), { tty: false }), prompter: p, auto }, printed };
}

test('confirm: Enter takes the default; y / n; anything else asks again', async () => {
  const { a } = asker(['', 'maybe', 'N', 'yes'], false);
  assert.equal(await confirm(a, 'Run it?', true), true);
  assert.equal(await confirm(a, 'Run it?', true), false); // "maybe" is not an answer; "N" is
  assert.equal(await confirm(a, 'Run it?', false), true);
});

test('--yes answers a plain question with its default and reads nothing', async () => {
  const { a, printed } = asker(['n'], true);
  assert.equal(await confirm(a, 'Run the smoke test?', true), true);
  assert.match(printed.join(''), /Run the smoke test\? \[Y\/n\] yes {3}\(--yes: the default\)/);
  assert.equal(await a.prompter.ask(''), 'n', 'the scripted line was not consumed');
});

test('--yes NEVER answers a money question: it is asked, and what is typed decides', async () => {
  const { a } = asker(['n', 'y'], true);
  assert.equal(await confirm(a, 'Is that the wallet you mean?', true, { money: true }), false);
  assert.equal(await confirm(a, 'Add the lines to .env.local?', false, { money: true }), true);
});

test('choose: a number, Enter for the default, an unavailable option is refused', async () => {
  const options = [{ key: 'have', label: 'I have one' }, { key: 'create', label: 'Create one', disabled: 'not in this version' }, { key: 'skip', label: 'Skip' }] as const;
  const { a, printed } = asker(['2', '9', '', '1'], false);
  assert.equal(await choose(a, 'Which?', options, 'skip'), 'skip'); // 2 is disabled, 9 does not exist, Enter = default
  assert.equal(await choose(a, 'Which?', options, 'skip'), 'have');
  assert.match(printed.join(''), /2\. Create one {3}\(not available: not in this version\)/);
  const auto = asker([], true);
  assert.equal(await choose(auto.a, 'Which?', options, 'skip'), 'skip');
});

test('askValue: checked, asked again when wrong; --yes uses the given default only for plain questions', async () => {
  const parse = (raw: string) => (/^\d+$/.test(raw.trim() || '50') ? { ok: true as const, value: Number(raw.trim() || '50') } : { ok: false as const, problem: 'a number, please' });
  const { a, printed } = asker(['abc', '20'], false);
  assert.equal(await askValue(a, 'Fee?', parse), 20);
  assert.match(printed.join(''), /a number, please/);
  assert.equal(await askValue(asker([], true).a, 'Fee?', parse, { auto: '' }), 50);
  assert.equal(await askValue(asker(['7'], true).a, 'Fee?', parse, { auto: '', money: true }), 7);
});

test('typing the wallet address: exact (case aside), never automatic, three tries or "q"', async () => {
  const address = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
  assert.equal(await typeExactly(asker([address.toLowerCase()], true).a, 'Type the address:', address), true);
  assert.equal(await typeExactly(asker(['0x1111111111111111111111111111111111111111', ` ${address} `], true).a, 'Type the address:', address), true);
  assert.equal(await typeExactly(asker(['q'], true).a, 'Type the address:', address), false);
  assert.equal(await typeExactly(asker(['a', 'b', 'c', address], true).a, 'Type the address:', address), false);
  // The real-funds word is taken only as written.
  assert.equal(await typeExactly(asker(['yes', 'Yes', 'YES'], true).a, 'Type YES:', 'YES', { exactCase: true }), true);
  assert.equal(await typeExactly(asker(['yes', 'y', 'ok'], true).a, 'Type YES:', 'YES', { exactCase: true }), false);
});

test('a question nobody can answer (the input ended) stops the run instead of guessing', async () => {
  await assert.rejects(confirm(asker([], false).a, 'Run it?', true), Stopped);
  await assert.rejects(typeExactly(asker([], true).a, 'Type YES:', 'YES'), Stopped);
  await assert.rejects(pressEnter(asker([], false).a), Stopped);
  // With --yes a pause is no question.
  await pressEnter(asker([], true).a);
});

// --- child processes ----------------------------------------------------------------------------

test('childEnv: the key variable is never inherited - a child gets a key only when it is handed one', () => {
  const key = generatePrivateKey();
  const base = { PATH: '/bin', VS_E2E_KEY: 'from-the-shell', vs_e2e_key: 'lower-case too', OTHER: 'x' };
  const plain = childEnv(base);
  assert.equal(Object.keys(plain).some((k) => k.toUpperCase() === KEY_ENV), false);
  assert.equal(plain.OTHER, 'x');
  assert.equal(plain.NO_COLOR, '1');
  const runner = childEnv(base, key);
  assert.equal(runner[KEY_ENV], key);
  assert.equal(Object.keys(runner).filter((k) => k.toUpperCase() === KEY_ENV).length, 1);
  assert.equal(base.VS_E2E_KEY, 'from-the-shell', 'the base environment is not changed');
});

test('a real child: it sees the key exactly when it was handed one; this process never has it', async () => {
  const key = generatePrivateKey();
  // The child says whether the variable is set and how long it is - never what it holds.
  const script = "const k = process.env.VS_E2E_KEY; console.log(k === undefined ? 'no key' : 'key of ' + k.length); console.error('on stderr'); process.stdout.write('no newline at the end')";
  const run = async (env: NodeJS.ProcessEnv): Promise<{ out: string[]; err: string[]; code: number | null }> => {
    const out: string[] = [];
    const err: string[] = [];
    const r = await runProcess(process.execPath, ['-e', script], { cwd: process.cwd(), env, onLine: (l, from) => (from === 'out' ? out : err).push(l) });
    return { out, err, code: r.code };
  };
  // Whether THIS process has the variable is looked at by name only - its value is never read.
  const hasVar = (): boolean => Object.keys(process.env).some((k) => k.toUpperCase() === KEY_ENV);
  const before = hasVar();
  const without = await run(childEnv(process.env));
  assert.deepEqual(without.out, ['no key', 'no newline at the end']);
  assert.deepEqual(without.err, ['on stderr']);
  assert.equal(without.code, 0);
  const withKey = await run(childEnv(process.env, key));
  assert.deepEqual(withKey.out, ['key of 66', 'no newline at the end']);
  assert.equal(hasVar(), before, 'handing a child a key does not put it into this process');
});

test('runProcess: exit codes, a program that does not exist, a timeout', async () => {
  const env = childEnv(process.env);
  assert.equal((await runProcess(process.execPath, ['-e', 'process.exit(3)'], { cwd: process.cwd(), env })).code, 3);
  const missing = await runProcess('this-program-does-not-exist-anywhere', [], { cwd: process.cwd(), env });
  assert.equal(missing.code, null);
  assert.ok(missing.startError);
  const slow = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: process.cwd(), env, timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.ok(slow.ms < 20_000);
});
