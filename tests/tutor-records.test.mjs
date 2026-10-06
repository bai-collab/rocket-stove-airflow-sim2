import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CpuRocketSimulation } from '../src/simulation/CpuRocketSimulation.mjs';
import { CLASS_GOALS, normalizeGoal, summarizeRun } from '../src/tutor/goals.mjs';
import { mockTutorReply } from '../src/tutor/mock-tutor.mjs';
import { SERIES_METRICS, buildStoveContext, sanitizeStoveContext } from '../src/tutor/stove-context.mjs';
import { cleanStudentId, openRecordStore } from '../scripts/tutor/record-store.mjs';
import { analysisContext, localAnalysis, selectRecords } from '../scripts/tutor/teacher-analysis.mjs';
import { openTeacherConfig } from '../scripts/tutor/teacher-config.mjs';
import { createTutorServer } from '../scripts/tutor/server.mjs';

const PASSWORD = 'correct horse battery';
const tempDir = (prefix) => fs.mkdtemp(path.join(os.tmpdir(), prefix));

/** Run the CPU reference for `seconds` and sample the series the way the browser does. */
function burnedContext(preset = 'straight', seconds = 12) {
  const sim = new CpuRocketSimulation();
  sim.loadPreset(preset);
  sim.ignite();
  const series = [];
  while (sim.time < seconds) {
    sim.step();
    const d = sim.diagnostics();
    if (!series.length || d.time - series.at(-1).t >= 2) {
      const point = { t: d.time, burning: d.fuelPhase === 'burning' ? 1 : 0 };
      for (const key of SERIES_METRICS) point[key] = d[key];
      series.push(point);
    }
  }
  return buildStoveContext({
    preset, edited: false, walls: sim.walls, fuels: sim.fuels, ignited: true, backend: 'cpu',
    diagnostics: sim.diagnostics(), series, runStart: 0,
  });
}

function idleContext() {
  const sim = new CpuRocketSimulation();
  sim.loadPreset('straight');
  return buildStoveContext({
    preset: 'straight', edited: false, walls: sim.walls, fuels: sim.fuels, ignited: false, backend: 'cpu',
    diagnostics: sim.diagnostics(), series: [],
  });
}

test('goals normalize and run summaries describe the test segment', () => {
  assert.deepEqual(Object.keys(CLASS_GOALS), ['free', 'lowSmoke', 'keepChar', 'stableBurn']);
  assert.equal(normalizeGoal('keepChar'), 'keepChar');
  assert.equal(normalizeGoal('__proto__'), 'free');

  const context = sanitizeStoveContext(burnedContext());
  const summary = summarizeRun(context);
  assert.ok(summary.durationSec >= 11);
  assert.ok(summary.samples >= 5);
  assert.ok(summary.burnFraction >= 0 && summary.burnFraction <= 1);
  assert.ok(summary.peakFuelTemperature > 25);
  assert.equal(typeof summary.secondaryObserved, 'boolean');

  const later = sanitizeStoveContext({ ...burnedContext(), run: { ...burnedContext().run, startTime: 8 } });
  assert.ok(summarizeRun(later).samples < summary.samples);
});

test('mock tutor steers toward the class goal', () => {
  const context = sanitizeStoveContext(idleContext());
  assert.match(mockTutorReply(context, '開始', 'lowSmoke').guidance, /低黑煙/);
  const burning = sanitizeStoveContext(burnedContext());
  const reply = mockTutorReply({ ...burning, run: { ...burning.run, latest: { ...burning.run.latest,
    pyrolysisFraction: 0.5, fuelOxygen: 0.5, charRetention: 0.5, smoke: 0.01, smokeOut: 0, averageWallConductivity: 0.7 } } }, '下一步', 'stableBurn');
  assert.match(reply.guidance, /穩定燃燒/);
});

test('student ids allow Chinese, letters, digits, underscore and dash only', () => {
  assert.equal(cleanStudentId(' 王小明_01 '), '王小明_01');
  for (const bad of ['', ' ', 'a b', '<script>', 'x'.repeat(21), 5]) assert.throws(() => cleanStudentId(bad), { code: 'INVALID_STUDENT_ID' });
});

test('record store assigns ids, persists and skips damaged lines', async () => {
  const file = path.join(await tempDir('records-'), 'events.jsonl');
  let clock = Date.UTC(2026, 9, 6, 1, 2, 3);
  const store = await openRecordStore(file, { now: () => clock++ });
  const a = await store.append({ type: 'test', studentId: 'S01', goal: 'lowSmoke', design: {}, summary: {} });
  const b = await store.append({ type: 'tutor', studentId: 'S01', goal: 'nonsense', design: {} });
  assert.match(a.id, /^r_[a-z0-9]+_[0-9a-f]{12}$/);
  assert.equal(a.seq + 1, b.seq);
  assert.equal(a.timestamp, '2026-10-06T01:02:03.000Z');
  assert.equal(b.goal, 'free');
  await fs.appendFile(file, 'not json\n{"type":"other"}\n');
  const reopened = await openRecordStore(file);
  assert.deepEqual(reopened.all().map((r) => r.id), [a.id, b.id]);
  assert.equal(reopened.skipped(), 2);
  const c = await reopened.append({ type: 'test', studentId: 'S02', design: {}, summary: {} });
  assert.equal(c.seq, b.seq + 1);
});

test('local analysis cites records and compares first and last tests per student', () => {
  const design = sanitizeStoveContext(idleContext());
  const records = [
    { id: 'r_aaaaaaaa1', seq: 1, type: 'test', studentId: 'S01', timestamp: '2026-10-06T01:00:00.000Z', goal: 'lowSmoke',
      design, summary: { smokeOut: 0.3, charRetention: 0.4, burnFraction: 0.5 } },
    { id: 'r_aaaaaaaa2', seq: 2, type: 'tutor', studentId: 'S01', timestamp: '2026-10-06T01:01:00.000Z', goal: 'lowSmoke',
      design, mode: 'mock', status: 'completed', question: 'q', guidance: 'g', followup: 'f' },
    { id: 'r_aaaaaaaa3', seq: 3, type: 'test', studentId: 'S01', timestamp: '2026-10-06T01:02:00.000Z', goal: 'lowSmoke',
      design, summary: { smokeOut: 0.1, charRetention: 0.5, burnFraction: 0.9 } },
  ];
  assert.throws(() => selectRecords(records, ['r_missing00']), { code: 'INVALID_SELECTION' });
  assert.throws(() => selectRecords(records, ['r_aaaaaaaa1', 'r_aaaaaaaa1']), { code: 'INVALID_SELECTION' });
  const selected = selectRecords(records, ['r_aaaaaaaa3', 'r_aaaaaaaa1']);
  assert.deepEqual(selected.map((r) => r.id), ['r_aaaaaaaa1', 'r_aaaaaaaa3']);
  const result = localAnalysis(records);
  assert.match(result.observations[1].text, /0\.3 → 0\.1/);
  assert.deepEqual(result.observations[1].recordIds, ['r_aaaaaaaa1', 'r_aaaaaaaa3']);
  const context = analysisContext(records);
  assert.equal(context.count, 3);
  assert.match(context.records[0].stoveMap, /F/);
  assert.equal(context.records[1].stoveMap, undefined);
  assert.equal(context.records[0].goal, '低黑煙');
});

test('server records tests and tutor turns, and teachers can read and analyze them', async () => {
  const staticDir = await tempDir('tutor-static-');
  const settingsFile = path.join(await tempDir('tutor-settings-'), 's.json');
  const config = await openTeacherConfig(settingsFile);
  await config.update({ password: PASSWORD, aiKey: 'nmk-test-key-123456', goal: 'keepChar' });
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    const payload = JSON.parse(calls.at(-1).input.at(-1).content);
    if (payload.context) {
      const id = payload.context.records[0].id;
      const answer = calls.length === 2
        ? { observations: [{ text: '看得到測試', recordIds: ['r_not_in_batch'] }], interpretations: [], suggestions: [], limitations: ['x'] }
        : { observations: [{ text: '有一次測試', recordIds: [id] }], interpretations: [], suggestions: [{ text: '請學生說明', recordIds: [] }], limitations: ['只看選取紀錄'] };
      return new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify(answer) }), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  };
  const server = await createTutorServer({
    port: 0, staticDir, settingsFile, recordsFile: path.join(await tempDir('tutor-records-'), 'e.jsonl'), env: {}, fetchImpl,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, cookie = '') => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await (await fetch(`${base}/api/tutor/status`)).json()).goal.label, '多留炭');

    // Student side.
    assert.equal((await post('/api/records', { studentId: '', context: burnedContext() })).status, 400);
    const short = await post('/api/records', { studentId: 'S01', context: idleContext() });
    assert.equal((await short.json()).code, 'TEST_TOO_SHORT');
    const saved = await post('/api/records', { studentId: 'S01', context: burnedContext(), endReason: 'reset' });
    assert.equal(saved.status, 200);
    const { id: testId } = await saved.json();
    const noId = await post('/api/tutor', { mode: 'mock', question: 'q', context: idleContext() });
    assert.equal((await noId.json()).code, 'INVALID_STUDENT_ID');
    assert.equal((await post('/api/tutor', { mode: 'mock', studentId: 'S01', question: '怎麼開始', context: idleContext() })).status, 200);
    const failed = await post('/api/tutor', { mode: 'model', studentId: 'S02', question: '黑煙', context: idleContext() });
    assert.equal((await failed.json()).code, 'PROVIDER_ERROR');

    // Teacher side.
    assert.equal((await fetch(`${base}/api/teacher/records`)).status, 401);
    const login = await post('/api/teacher/login', { password: PASSWORD });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const list = await (await fetch(`${base}/api/teacher/records`, { headers: { Cookie: cookie } })).json();
    assert.equal(list.total, 3);
    assert.deepEqual(list.records.map((r) => [r.type, r.studentId, r.status ?? 'test']),
      [['tutor', 'S02', 'failed'], ['tutor', 'S01', 'completed'], ['test', 'S01', 'test']]);
    const test = list.records[2];
    assert.equal(test.id, testId);
    assert.equal(test.goal, 'keepChar');
    assert.equal(test.endReason, 'reset');
    assert.ok(test.design.walls.length > 0);
    assert.equal(list.records[1].guidance.length > 0, true);
    assert.equal(list.records[0].errorCode, 'PROVIDER_ERROR');
    assert.equal(JSON.stringify(list).includes('nmk-test-key'), false);

    const local = await (await post('/api/teacher/analyze', { mode: 'local', recordIds: [testId] }, cookie)).json();
    assert.equal(local.source, 'local');
    assert.deepEqual(local.result.observations[0].recordIds, [testId]);

    const badCitation = await post('/api/teacher/analyze', { mode: 'model', recordIds: [testId], question: '整理' }, cookie);
    assert.equal((await badCitation.json()).code, 'INVALID_MODEL_OUTPUT');
    const good = await (await post('/api/teacher/analyze', { mode: 'model', recordIds: [testId], question: '整理' }, cookie)).json();
    assert.deepEqual(good.result.observations[0].recordIds, [testId]);
    assert.match(calls.at(-1).input[0].content, /不排名學生/);

    assert.equal((await post('/api/teacher/analyze', { mode: 'local', recordIds: ['r_nope_0000'] }, cookie)).status, 400);
    assert.equal((await post('/api/teacher/analyze', { mode: 'local', recordIds: [testId] })).status, 401);

    const goal = await post('/api/teacher/settings', { goal: 'lowSmoke' }, cookie);
    assert.equal((await goal.json()).goal, 'lowSmoke');
    assert.equal((await post('/api/teacher/settings', { goal: 'win' }, cookie)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
