import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CpuRocketSimulation } from '../src/simulation/CpuRocketSimulation.mjs';
import { buildStoveContext } from '../src/tutor/stove-context.mjs';
import { createTutorServer } from '../scripts/tutor/server.mjs';

const staticDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutor-static-'));
await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>sim</title>');
await fs.mkdir(path.join(staticDir, 'assets'));
await fs.writeFile(path.join(staticDir, 'assets', 'app.js'), 'export {};');
await fs.writeFile(path.join(staticDir, '.env'), 'SECRET=1');
await fs.writeFile(path.join(path.dirname(staticDir), 'outside.txt'), 'outside');

const server = await createTutorServer({ port: 0, staticDir, settingsFile: path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'tutor-settings-')), 'settings.json') });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
test.after(() => new Promise((resolve) => server.close(resolve)));

function context() {
  const sim = new CpuRocketSimulation();
  sim.loadPreset('straight');
  return buildStoveContext({
    preset: 'straight', edited: false, walls: sim.walls, fuels: sim.fuels,
    ignited: false, backend: 'cpu', diagnostics: sim.diagnostics(), series: [],
  });
}

function ask(body, headers = {}) {
  return fetch(`${base}/api/tutor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('status reports mock mode only and no secrets', async () => {
  const response = await fetch(`${base}/api/tutor/status`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true, modes: { mock: true, model: false } });
});

test('mock tutor answers with grounded guidance', async () => {
  const response = await ask({ mode: 'mock', question: '我要怎麼開始？', context: context() });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.source, 'mock');
  assert.match(data.reply.guidance, /點火/);
  assert.ok(Array.isArray(data.reply.relatedCells));
  assert.ok(Array.isArray(data.reply.relatedMetrics));
});

test('model mode is refused until a teacher saves an API key', async () => {
  const response = await ask({ mode: 'model', question: '你好', context: context() });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'MODEL_NOT_CONFIGURED');
  const unknown = await ask({ mode: 'magic', question: '你好', context: context() });
  assert.equal((await unknown.json()).code, 'INVALID_MODE');
});

test('bad questions, bad context and bad JSON are rejected', async () => {
  assert.equal((await ask({ mode: 'mock', question: '', context: context() })).status, 400);
  assert.equal((await ask({ mode: 'mock', question: '嗨', context: { version: 9 } })).status, 400);
  assert.equal((await ask('{not json')).status, 400);
  const wrongType = await fetch(`${base}/api/tutor`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}',
  });
  assert.equal(wrongType.status, 415);
});

test('oversized bodies are refused', async () => {
  const response = await ask({ mode: 'mock', question: 'x', padding: 'a'.repeat(70 * 1024) });
  assert.equal(response.status, 413);
});

test('cross-site and foreign-host requests are refused', async () => {
  assert.equal((await ask({ mode: 'mock', question: '嗨', context: context() }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await ask({ mode: 'mock', question: '嗨', context: context() }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const rebinding = await new Promise((resolve, reject) => {
    import('node:http').then(({ request }) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/tutor/status', headers: { Host: `evil.example:${port}` } }, resolve);
      req.on('error', reject);
      req.end();
    });
  });
  assert.equal(rebinding.statusCode, 421);
  rebinding.resume();
});

test('static files are served from the build folder only', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  const asset = await fetch(`${base}/assets/app.js`);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/outside.txt`)).status, 404);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
});
