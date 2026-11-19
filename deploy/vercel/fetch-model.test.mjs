// node --test deploy/vercel/fetch-model.test.mjs
//
// The speech model's fetch (deploy/vercel/fetch-model.sh): every file checked against its checksum, a file
// that does not match never served, and the build cache used when it holds the right bytes - against a
// stand-in for Hugging Face on loopback (VS_MODEL_BASE_URL) with small made-up files (VS_MODEL_SUMS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_CACHE, config } from './package.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'fetch-model.sh').replace(/\\/g, '/');
const SKIP = spawnSync('bash', ['-c', 'command -v curl']).status === 0 ? false : 'needs bash and curl';
const REPO = 'onnx-community/moonshine-tiny-ONNX';
const REV = 'a6da1241cd305dcd64eab1edbd615f2bb9aabb95';
const FILES = { 'config.json': '{"model_type":"moonshine"}', 'onnx/encoder_model_quantized.onnx': 'encoder-bytes', 'onnx/decoder_model_merged_quantized.onnx': 'decoder-bytes' };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const slash = (p) => p.replace(/\\/g, '/');

/** A stand-in for Hugging Face: `bad` names a file it answers with other bytes. */
function hub(bad = new Set()) {
  const asked = [];
  const s = http.createServer((req, res) => {
    const f = req.url.slice(1);
    asked.push(f);
    if (!(f in FILES)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200);
    res.end(bad.has(f) ? 'tampered' : FILES[f]);
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${s.address().port}`, asked, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) })));
}

function run(dest, cache, h, sums) {
  return new Promise((done) => {
    const args = [SCRIPT, slash(dest), ...(cache ? [slash(cache)] : [])];
    const child = spawn('bash', args, { env: { ...process.env, VS_MODEL_BASE_URL: h.url, VS_MODEL_SUMS: slash(sums) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.once('exit', (code) => done({ code, err }));
  });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'vs-model-'));
  const sums = join(dir, 'model.sha256');
  writeFileSync(sums, Object.entries(FILES).map(([f, body]) => `${sha(body)}  ${f}`).join('\r\n') + '\r\n');
  return { dir, sums };
}
const model = (dest, f) => join(dest, 'models', REPO, f);

test('the checksum list is the pinned revision\'s: eight files, the two weights with Hugging Face\'s LFS ids', () => {
  const lines = readFileSync(join(HERE, 'model.sha256'), 'utf8').trim().split(/\r?\n/).map((l) => l.split(/\s+/));
  assert.equal(lines.length, 8);
  assert.ok(lines.every(([h, f]) => /^[0-9a-f]{64}$/.test(h) && f), 'sha256 and a path on every line');
  const byFile = Object.fromEntries(lines.map(([h, f]) => [f, h]));
  assert.equal(byFile['onnx/encoder_model_quantized.onnx'], 'c6fc4b7bc5af75c0591fd157a1f3829b533d18e9769a888fd95a62e470dd4f4a');
  assert.equal(byFile['onnx/decoder_model_merged_quantized.onnx'], 'eed87831c3a6103534aae7d47a5d485025c659a1323901513961c39fe8a1a367');
  assert.match(readFileSync(join(HERE, 'fetch-model.sh'), 'utf8'), new RegExp(`rev=${REV}`));
});

test('the build keeps the model between builds where Vercel restores it', () => {
  assert.deepEqual(config().cache, [`${MODEL_CACHE}/**`]);
  assert.match(readFileSync(join(HERE, 'build.sh'), 'utf8'), new RegExp(`fetch-model\\.sh apps/web/dist ${MODEL_CACHE.replace(/\./g, '\\.')}\\b`));
});

test('without a cache: fetched and checked into the site; a second run fetches nothing', { skip: SKIP }, async () => {
  const { dir, sums } = setup();
  const h = await hub();
  try {
    const dest = join(dir, 'dist');
    const r = await run(dest, null, h, sums);
    assert.equal(r.code, 0, r.err);
    for (const [f, body] of Object.entries(FILES)) assert.equal(readFileSync(model(dest, f), 'utf8'), body, f);
    assert.ok(existsSync(model(dest, 'LICENSE.txt')), 'the MIT notice goes with the weights');
    assert.equal(h.asked.length, 3);
    const again = await run(dest, null, h, sums);
    assert.equal(again.code, 0, again.err);
    assert.equal(h.asked.length, 3, 'files that match are not fetched again');
    assert.match(again.err, /3 file\(s\) .* as they were, 0 fetched/);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with a cache: the first build fills it, the next takes it from there; a damaged cached file is fetched again', { skip: SKIP }, async () => {
  const { dir, sums } = setup();
  const h = await hub();
  try {
    const cache = join(dir, 'cache');
    const one = await run(join(dir, 'one'), cache, h, sums);
    assert.equal(one.code, 0, one.err);
    assert.equal(h.asked.length, 3);
    assert.equal(readFileSync(join(cache, `${REPO}@${REV}`, 'config.json'), 'utf8'), FILES['config.json'], 'one folder per revision');
    const two = await run(join(dir, 'two'), cache, h, sums);
    assert.equal(two.code, 0, two.err);
    assert.equal(h.asked.length, 3, 'nothing from Hugging Face');
    for (const [f, body] of Object.entries(FILES)) assert.equal(readFileSync(model(join(dir, 'two'), f), 'utf8'), body);
    writeFileSync(join(cache, `${REPO}@${REV}`, 'onnx', 'encoder_model_quantized.onnx'), 'half a fil');
    const three = await run(join(dir, 'three'), cache, h, sums);
    assert.equal(three.code, 0, three.err);
    assert.deepEqual(h.asked.slice(3), ['onnx/encoder_model_quantized.onnx'], 'only the damaged one');
    assert.equal(readFileSync(model(join(dir, 'three'), 'onnx/encoder_model_quantized.onnx'), 'utf8'), FILES['onnx/encoder_model_quantized.onnx']);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that does not match its checksum fails the build and is never served', { skip: SKIP }, async () => {
  const { dir, sums } = setup();
  const h = await hub(new Set(['onnx/decoder_model_merged_quantized.onnx']));
  try {
    const dest = join(dir, 'dist');
    const cache = join(dir, 'cache');
    const r = await run(dest, cache, h, sums);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /decoder_model_merged_quantized\.onnx does not match its checksum/);
    assert.ok(!existsSync(model(dest, 'onnx/decoder_model_merged_quantized.onnx')), 'not in the site');
    assert.ok(!existsSync(join(cache, `${REPO}@${REV}`, 'onnx', 'decoder_model_merged_quantized.onnx')), 'not kept either');
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
