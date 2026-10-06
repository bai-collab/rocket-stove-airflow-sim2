import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CpuRocketSimulation } from '../src/simulation/CpuRocketSimulation.mjs';
import { buildStoveContext, sanitizeHistory, sanitizeStoveContext } from '../src/tutor/stove-context.mjs';
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, providerConfig, requestModelGuidance } from '../scripts/tutor/nmking.mjs';
import { openTeacherConfig } from '../scripts/tutor/teacher-config.mjs';
import { createTutorServer } from '../scripts/tutor/server.mjs';

const API_KEY = 'nmk-test-key-123456';
const PASSWORD = 'correct horse battery';

function rawContext() {
  const sim = new CpuRocketSimulation();
  sim.loadPreset('straight');
  return buildStoveContext({
    preset: 'straight', edited: false, walls: sim.walls, fuels: sim.fuels,
    ignited: false, backend: 'cpu', diagnostics: sim.diagnostics(), series: [],
  });
}

function modelResponse(result, extra = {}) {
  return new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
    ...extra,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** Fake NMKING endpoint: records each request and answers from a queue. */
function fakeProvider() {
  const calls = [];
  const replies = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = replies.shift();
    if (!next) throw new Error('no fake reply queued');
    return typeof next === 'function' ? next(init) : next;
  };
  return { calls, replies, fetchImpl };
}

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('provider config defaults to NMKING and accepts env overrides', () => {
  assert.deepEqual(providerConfig({}), { endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MODEL, reasoning: 'max' });
  assert.deepEqual(providerConfig({ TUTOR_AI_MODEL: 'm', TUTOR_AI_ENDPOINT: 'http://x', TUTOR_AI_REASONING: 'bogus' }),
    { endpoint: 'http://x', model: 'm', reasoning: 'max' });
});

test('history keeps the last six well-formed turns', () => {
  const turns = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'tutor' : 'student', text: ` t${i} ` }));
  const clean = sanitizeHistory([...turns, { role: 'system', text: 'x' }, { role: 'student', text: 5 }]);
  assert.equal(clean.length, 6);
  assert.deepEqual(clean[0], { role: 'tutor', text: 't3' });
  assert.deepEqual(sanitizeHistory('nope'), []);
});

test('model request uses NMKING wiring and returns a grounded reply', async () => {
  const context = sanitizeStoveContext(rawContext());
  const fake = fakeProvider();
  const wall = context.walls[0];
  fake.replies.push(modelResponse({
    guidance: '先看 smoke 的變化。', question: '黑煙往哪裡走？',
    relatedCells: [wall, { c: 0, r: 0 }], relatedMetrics: ['smoke', 'nope'],
  }));
  const reply = await requestModelGuidance({
    apiKey: API_KEY, context, question: '黑煙怎麼辦', history: [{ role: 'student', text: '前一題' }],
    config: providerConfig({}), fetchImpl: fake.fetchImpl,
  });
  assert.equal(reply.guidance, '先看「相對黑煙量」的變化。');
  assert.deepEqual(reply.relatedCells, [{ c: wall.c, r: wall.r }]);
  assert.deepEqual(reply.relatedMetrics, ['smoke']);

  const [call] = fake.calls;
  assert.equal(call.url, DEFAULT_ENDPOINT);
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(call.init.headers['x-nmking-locale'], 'zh-TW');
  assert.equal(call.body.model, DEFAULT_MODEL);
  assert.equal(call.body.stream, false);
  assert.equal(call.body.store, false);
  assert.equal(call.body.input[0].role, 'system');
  assert.match(call.body.input[0].content, /藍色粒子只是氣流示蹤/);
  assert.deepEqual(call.body.input[1], { role: 'user', content: '前一題' });
  const payload = JSON.parse(call.body.input.at(-1).content);
  assert.equal(payload.studentQuestion, '黑煙怎麼辦');
  assert.match(payload.stoveMap, /F/);
  assert.equal(typeof payload.ruleHint, 'string');
});

test('model failures map to stable codes and never leak the key', async () => {
  const context = sanitizeStoveContext(rawContext());
  const config = providerConfig({});
  const cases = [
    [new Response('{}', { status: 401 }), 'AUTH_REJECTED'],
    [new Response('{}', { status: 429 }), 'RATE_LIMITED'],
    [new Response('{}', { status: 500 }), 'PROVIDER_ERROR'],
    [new Response('not json', { status: 200 }), 'INVALID_PROVIDER_RESPONSE'],
    [new Response(JSON.stringify({ status: 'incomplete' }), { status: 200 }), 'MODEL_INCOMPLETE'],
    [new Response(JSON.stringify({ output_text: 'hello' }), { status: 200 }), 'INVALID_MODEL_OUTPUT'],
    [modelResponse({ guidance: '', question: 'q' }), 'INVALID_MODEL_OUTPUT'],
    [modelResponse({ guidance: `金鑰是 ${API_KEY}`, question: 'q' }), 'INVALID_MODEL_OUTPUT'],
  ];
  for (const [response, code] of cases) {
    await assert.rejects(
      requestModelGuidance({ apiKey: API_KEY, context, question: 'q', config, fetchImpl: async () => response }),
      (error) => error.code === code && !error.message.includes(API_KEY),
      code,
    );
  }
  await assert.rejects(
    requestModelGuidance({ apiKey: API_KEY, context, question: 'q', config, fetchImpl: async () => { throw new TypeError('fetch failed'); } }),
    { code: 'UPSTREAM_NETWORK' },
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    requestModelGuidance({ apiKey: API_KEY, context, question: 'q', config, signal: aborted.signal,
      fetchImpl: async () => { throw new DOMException('aborted', 'AbortError'); } }),
    { code: 'TIMEOUT' },
  );
  const fenced = new Response(JSON.stringify({ output_text: '```json\n{"guidance":"g","question":"q"}\n```' }), { status: 200 });
  const reply = await requestModelGuidance({ apiKey: API_KEY, context, question: 'q', config, fetchImpl: async () => fenced });
  assert.equal(reply.guidance, 'g');
});

test('teacher config hashes the password, keeps blanks and clears explicitly', async () => {
  const file = path.join(await tempDir('teacher-config-'), 'settings.json');
  const config = await openTeacherConfig(file);
  assert.deepEqual(config.status(), { initialized: false, aiConfigured: false });
  await assert.rejects(config.update({ password: 'short' }), { code: 'INVALID_PASSWORD' });
  await config.update({ password: PASSWORD, aiKey: API_KEY });
  const stored = await fs.readFile(file, 'utf8');
  assert.equal(stored.includes(PASSWORD), false);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(config.verify(PASSWORD), true);
  assert.equal(config.verify('wrong password!!'), false);

  await config.update({ aiKey: '' });
  assert.equal(config.apiKey(), API_KEY);
  await assert.rejects(config.update({ aiKey: 'has space in key' }), { code: 'INVALID_API_KEY' });
  await config.update({ clearAi: true });
  assert.equal(config.apiKey(), '');

  const reopened = await openTeacherConfig(file);
  assert.deepEqual(reopened.status(), { initialized: true, aiConfigured: false });
  assert.equal(reopened.verify(PASSWORD), true);

  await fs.writeFile(file, '{"version":1}');
  await assert.rejects(openTeacherConfig(file), { code: 'SETTINGS_CORRUPT' });
});

test('teacher setup, login, settings and the student model path end to end', async () => {
  const staticDir = await tempDir('tutor-static-');
  await fs.writeFile(path.join(staticDir, 'index.html'), 'ok');
  const fake = fakeProvider();
  const server = await createTutorServer({
    port: 0, staticDir, settingsFile: path.join(await tempDir('tutor-settings-'), 's.json'),
    recordsFile: path.join(await tempDir('tutor-records-'), 'e.jsonl'),
    env: { TUTOR_AI_PER_MINUTE: '2' }, fetchImpl: fake.fetchImpl,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (route, body, cookie = '') => fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const session = async (cookie = '') => (await fetch(`${base}/api/teacher/session`, { headers: cookie ? { Cookie: cookie } : {} })).json();

    assert.deepEqual(await session(), { initialized: false, aiConfigured: false, goal: 'free', loggedIn: false });
    assert.equal((await post('/api/teacher/login', { password: PASSWORD })).status, 409);
    assert.equal((await post('/api/teacher/setup', { password: 'short' })).status, 400);

    const setup = await post('/api/teacher/setup', { password: PASSWORD });
    assert.equal(setup.status, 200);
    const setCookie = setup.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\/api\/teacher/);
    const cookie = setCookie.split(';')[0];
    assert.deepEqual(await session(cookie), { initialized: true, aiConfigured: false, goal: 'free', loggedIn: true });
    assert.equal((await post('/api/teacher/setup', { password: PASSWORD })).status, 409);

    // Settings require a session and a same-origin request.
    assert.equal((await post('/api/teacher/settings', { aiKey: API_KEY })).status, 401);
    const crossSite = await fetch(`${base}/api/teacher/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: cookie },
      body: JSON.stringify({ aiKey: API_KEY }),
    });
    assert.equal(crossSite.status, 403);
    const saved = await post('/api/teacher/settings', { aiKey: API_KEY }, cookie);
    assert.deepEqual(await saved.json(), { initialized: true, aiConfigured: true, goal: 'free', loggedIn: true });

    const status = await (await fetch(`${base}/api/tutor/status`)).json();
    assert.deepEqual(status.modes, { mock: true, model: true });
    assert.equal(JSON.stringify(status).includes(API_KEY), false);

    // Student asks in model mode.
    fake.replies.push(modelResponse({ guidance: '先看氧氣。', question: '空氣從哪裡進來？', relatedMetrics: ['fuelOxygen'] }));
    const asked = await post('/api/tutor', {
      mode: 'model', studentId: 'S01', question: '火為什麼熄了', context: rawContext(),
      history: [{ role: 'student', text: '上一題' }, { role: 'tutor', text: '上一個提示' }],
    });
    assert.equal(asked.status, 200);
    const answer = await asked.json();
    assert.equal(answer.source, 'model');
    assert.deepEqual(answer.reply.relatedMetrics, ['fuelOxygen']);
    assert.equal(JSON.stringify(answer).includes(API_KEY), false);
    assert.equal(fake.calls[0].init.headers.Authorization, `Bearer ${API_KEY}`);
    assert.deepEqual(fake.calls[0].body.input.slice(1, 3).map((m) => m.role), ['user', 'assistant']);

    // Upstream rejection is reported without retrying.
    fake.replies.push(new Response('{}', { status: 401 }));
    const rejected = await post('/api/tutor', { mode: 'model', studentId: 'S01', question: '再問一次', context: rawContext() });
    assert.equal(rejected.status, 502);
    assert.equal((await rejected.json()).code, 'AUTH_REJECTED');
    assert.equal(fake.calls.length, 2);

    // Per-minute quota (set to 2 above) stops the third call before it leaves the computer.
    const limited = await post('/api/tutor', { mode: 'model', studentId: 'S01', question: '第三次', context: rawContext() });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, 'LOCAL_QUOTA');
    assert.equal(fake.calls.length, 2);

    // Wrong passwords lock login after five tries.
    for (let i = 0; i < 5; i += 1) assert.equal((await post('/api/teacher/login', { password: 'wrong password!!' })).status, 401);
    assert.equal((await post('/api/teacher/login', { password: PASSWORD })).status, 429);

    // Logout ends the session; clearing the key turns model mode off.
    assert.equal((await post('/api/teacher/settings', { clearAi: true }, cookie)).status, 200);
    assert.deepEqual((await (await fetch(`${base}/api/tutor/status`)).json()).modes, { mock: true, model: false });
    const out = await post('/api/teacher/logout', {}, cookie);
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await session(cookie)).loggedIn, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('only one model request runs at a time', async () => {
  const staticDir = await tempDir('tutor-static-');
  const settingsFile = path.join(await tempDir('tutor-settings-'), 's.json');
  const config = await openTeacherConfig(settingsFile);
  await config.update({ password: PASSWORD, aiKey: API_KEY });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => {
    await gate;
    return modelResponse({ guidance: 'g', question: 'q' });
  };
  const server = await createTutorServer({
    port: 0, staticDir, settingsFile, recordsFile: path.join(await tempDir('tutor-records-'), 'e.jsonl'), env: {}, fetchImpl,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = () => fetch(`${base}/api/tutor`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ mode: 'model', studentId: 'S01', question: 'q', context: rawContext() }),
  });
  try {
    const first = ask();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await ask();
    assert.equal(second.status, 429);
    assert.equal((await second.json()).code, 'LOCAL_BUSY');
    release();
    assert.equal((await first).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
