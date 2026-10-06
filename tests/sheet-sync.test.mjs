import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CpuRocketSimulation } from '../src/simulation/CpuRocketSimulation.mjs';
import { buildStoveContext, sanitizeStoveContext } from '../src/tutor/stove-context.mjs';
import { summarizeRun } from '../src/tutor/goals.mjs';
import { designOf, openRecordStore } from '../scripts/tutor/record-store.mjs';
import { cleanSyncedRecord, openSheetSync, wireRecord } from '../scripts/tutor/sheet-sync.mjs';
import { openTeacherConfig } from '../scripts/tutor/teacher-config.mjs';
import { createTutorServer } from '../scripts/tutor/server.mjs';
import { SHEET_URL, TOKEN, fakeAppsScript } from './helpers/fake-apps-script.mjs';

const tempDir = (prefix) => fs.mkdtemp(path.join(os.tmpdir(), prefix));
function testRecordFields(studentId, question = '') {
  const sim = new CpuRocketSimulation();
  sim.loadPreset('baffle');
  const context = sanitizeStoveContext(buildStoveContext({
    preset: 'baffle', edited: true, walls: sim.walls, fuels: sim.fuels, ignited: true, backend: 'cpu',
    diagnostics: { ...sim.diagnostics(), time: 9 }, series: [], runStart: 0,
  }));
  return question
    ? { type: 'tutor', studentId, goal: 'lowSmoke', mode: 'mock', status: 'completed', question,
      guidance: '看黑煙', followup: '為什麼？', relatedMetrics: ['smoke'], design: designOf(context) }
    : { type: 'test', studentId, goal: 'lowSmoke', endReason: 'reset', backend: 'cpu', design: designOf(context), summary: summarizeRun(context) };
}

async function computer(fetchImpl, config = { url: SHEET_URL, token: TOKEN }) {
  const dir = await tempDir('sync-');
  const store = await openRecordStore(path.join(dir, 'events.jsonl'));
  const sync = await openSheetSync({ store, stateFile: path.join(dir, 'sync.json'), getConfig: () => config, fetchImpl });
  return { store, sync, dir };
}

test('two computers share records through Code.gs without duplicates or loops', async () => {
  const gas = fakeAppsScript();
  const a = await computer(gas.fetchImpl);
  const b = await computer(gas.fetchImpl);
  await a.store.append(testRecordFields('S01'));
  await a.store.append(testRecordFields('S01', '=HYPERLINK("http://evil","x")'));
  await b.store.append(testRecordFields('小美_02'));

  assert.equal(a.sync.status().pending, 2);
  assert.deepEqual(await a.sync.sync(), { pushed: 2, imported: 0, skipped: 0, more: false });
  assert.deepEqual(await b.sync.sync(), { pushed: 1, imported: 2, skipped: 0, more: false });
  assert.deepEqual(await a.sync.sync(), { pushed: 0, imported: 1, skipped: 0, more: false });
  assert.deepEqual(await b.sync.sync(), { pushed: 0, imported: 0, skipped: 0, more: false });

  const rows = gas.sheet().rows;
  assert.equal(rows.length, 4); // header + 3 records, nothing pushed back
  const tutorRow = rows.find((row) => String(row[3]).includes('導師提問'));
  assert.equal(tutorRow[12], '​=HYPERLINK("http://evil","x")'); // stored as text, not a formula
  assert.equal(typeof rows[1][8], 'number');

  const fromA = a.store.all().find((r) => r.studentId === '小美_02');
  assert.equal(fromA.source, 'sheet');
  assert.equal(fromA.summary.durationSec, 9);
  assert.equal(b.store.all().filter((r) => r.source === 'sheet').length, 2);
  assert.equal(a.sync.status().pending, 0);
  assert.equal(a.sync.status().lastError, '');

  // State survives a restart: nothing is pushed or imported twice.
  const reopened = await openSheetSync({
    store: a.store, stateFile: path.join(a.dir, 'sync.json'), getConfig: () => ({ url: SHEET_URL, token: TOKEN }), fetchImpl: gas.fetchImpl,
  });
  assert.equal(reopened.computer(), a.sync.computer());
  assert.deepEqual(await reopened.sync(), { pushed: 0, imported: 0, skipped: 0, more: false });
});

test('damaged rows are skipped and the rest still imported', async () => {
  const gas = fakeAppsScript();
  const a = await computer(gas.fetchImpl);
  await a.store.append(testRecordFields('S01'));
  await a.store.append(testRecordFields('S02'));
  await a.sync.sync();
  gas.sheet().rows[1][16] = '​{broken';
  const b = await computer(gas.fetchImpl);
  assert.deepEqual(await b.sync.sync(), { pushed: 0, imported: 1, skipped: 1, more: false });
});

test('sync errors are reported with stable codes', async () => {
  const wrongToken = fakeAppsScript('a-different-token-999');
  const a = await computer(wrongToken.fetchImpl);
  await a.store.append(testRecordFields('S01'));
  await assert.rejects(a.sync.sync(), { code: 'SHEET_AUTH_REJECTED' });
  assert.equal(a.sync.status().lastError, 'SHEET_AUTH_REJECTED');
  assert.equal(a.sync.status().pending, 1);

  const evilRedirect = async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/collect' } });
  await assert.rejects((await computer(evilRedirect)).sync.sync(), { code: 'SHEET_BAD_REDIRECT' });
  const loginPage = async () => new Response('<html>Sign in</html>', { status: 200 });
  await assert.rejects((await computer(loginPage)).sync.sync(), { code: 'SHEET_BAD_RESPONSE' });
  const offline = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects((await computer(offline)).sync.sync(), { code: 'SHEET_NETWORK' });
  await assert.rejects((await computer(offline, { url: '', token: '' })).sync.sync(), { code: 'SHEET_NOT_CONFIGURED' });
});

test('records from the sheet are validated strictly', async () => {
  const store = await openRecordStore(path.join(await tempDir('r-'), 'e.jsonl'));
  const record = wireRecord(await store.append(testRecordFields('S01')), 'abcd1234');
  assert.equal('seq' in record, false);
  const clean = cleanSyncedRecord(record);
  assert.equal(clean.computer, 'abcd1234');
  assert.equal(clean.design.walls.length, record.design.walls.length);
  for (const bad of [
    null, { ...record, id: 'x' }, { ...record, studentId: '<b>' }, { ...record, timestamp: 'yesterday' },
    { ...record, type: 'grade' }, { ...record, summary: { ...record.summary, smokeOut: 'lots' } },
  ]) assert.equal(cleanSyncedRecord(bad), null);
  const tutor = cleanSyncedRecord({ ...record, type: 'tutor', mode: 'model', status: 'completed', question: 'q',
    guidance: 'g', followup: 'f', relatedMetrics: ['smoke', 'apiKey'], computer: 'NOT-HEX' });
  assert.deepEqual(tutor.relatedMetrics, ['smoke']);
  assert.equal(tutor.computer, '');
});

test('teacher settings keep the sheet URL and token together', async () => {
  const config = await openTeacherConfig(path.join(await tempDir('cfg-'), 's.json'));
  await config.update({ password: 'correct horse battery' });
  await assert.rejects(config.update({ sheetUrl: SHEET_URL }), { code: 'SHEET_PAIR_REQUIRED' });
  await assert.rejects(config.update({ sheetUrl: 'https://evil.example/exec', sheetToken: TOKEN }), { code: 'INVALID_SHEET_URL' });
  await assert.rejects(config.update({ sheetUrl: SHEET_URL, sheetToken: 'short' }), { code: 'INVALID_SHEET_TOKEN' });
  await config.update({ sheetUrl: SHEET_URL, sheetToken: TOKEN });
  await config.update({ sheetUrl: '', sheetToken: '' });
  assert.deepEqual(config.sheet(), { url: SHEET_URL, token: TOKEN });
  await config.update({ clearSheet: true });
  assert.deepEqual(config.sheet(), { url: '', token: '' });
});

test('teacher sync endpoint pushes, pulls and never returns the token', async () => {
  const gas = fakeAppsScript();
  const dir = await tempDir('srv-');
  const server = await createTutorServer({
    port: 0, staticDir: dir, settingsFile: path.join(dir, 's.json'), recordsFile: path.join(dir, 'e.jsonl'),
    syncStateFile: path.join(dir, 'sync.json'), env: {}, sheetFetchImpl: gas.fetchImpl,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, cookie = '') => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  try {
    const setup = await post('/api/teacher/setup', { password: 'correct horse battery' });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    assert.equal((await post('/api/teacher/sync', {}, cookie)).status, 409);
    const saved = await (await post('/api/teacher/settings', { sheetUrl: SHEET_URL, sheetToken: TOKEN }, cookie)).json();
    assert.equal(saved.sheetConfigured, true);

    const sim = new CpuRocketSimulation();
    sim.loadPreset('straight');
    const context = buildStoveContext({ preset: 'straight', edited: false, walls: sim.walls, fuels: sim.fuels,
      ignited: false, backend: 'cpu', diagnostics: sim.diagnostics(), series: [] });
    assert.equal((await post('/api/tutor', { mode: 'mock', studentId: 'S01', question: '開始', context })).status, 200);

    const synced = await post('/api/teacher/sync', {}, cookie);
    const body = await synced.json();
    assert.equal(synced.status, 200);
    assert.equal(body.result.pushed, 1);
    assert.equal(body.sync.pending, 0);
    assert.equal(gas.sheet().rows.length, 2);
    assert.equal(JSON.stringify(body).includes(TOKEN), false);
    const list = await (await fetch(`${base}/api/teacher/records`, { headers: { Cookie: cookie } })).json();
    assert.equal(list.sync.configured, true);
    assert.equal(JSON.stringify(list).includes(TOKEN), false);
    assert.equal((await post('/api/teacher/sync', {})).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
