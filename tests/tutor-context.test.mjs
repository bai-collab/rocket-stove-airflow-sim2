import test from 'node:test';
import assert from 'node:assert/strict';
import { CpuRocketSimulation } from '../src/simulation/CpuRocketSimulation.mjs';
import { mockTutorReply } from '../src/tutor/mock-tutor.mjs';
import {
  GRID_COLS,
  GRID_ROWS,
  MAX_RELATED,
  TUTOR_METRICS,
  asciiStoveMap,
  buildStoveContext,
  groundTutorReply,
  groundableCells,
  sanitizeQuestion,
  sanitizeStoveContext,
} from '../src/tutor/stove-context.mjs';

function contextFor(sim, preset = 'straight', series = []) {
  return buildStoveContext({
    preset,
    edited: false,
    walls: sim.walls,
    fuels: sim.fuels,
    ignited: sim.ignited,
    backend: 'cpu',
    diagnostics: sim.diagnostics(),
    series,
  });
}

function presetContext(preset = 'straight') {
  const sim = new CpuRocketSimulation();
  assert.equal(sim.loadPreset(preset), true);
  return { sim, context: sanitizeStoveContext(contextFor(sim, preset)) };
}

test('preset snapshot survives sanitizing with walls, fuel and metrics intact', () => {
  const { sim, context } = presetContext('baffle');
  assert.equal(context.grid.cols, GRID_COLS);
  assert.equal(context.grid.rows, GRID_ROWS);
  assert.equal(context.preset, 'baffle');
  assert.equal(context.walls.length, sim.walls.length);
  assert.equal(context.fuels.length, sim.fuels.length);
  assert.deepEqual(Object.keys(context.run.latest).sort(), Object.keys(TUTOR_METRICS).sort());
  for (const value of Object.values(context.run.latest)) assert.ok(Number.isFinite(value));
});

test('sanitizer drops unknown fields, out-of-grid cells, duplicates and fuel on walls', () => {
  const context = sanitizeStoveContext({
    version: 1,
    preset: '__proto__',
    walls: [
      { c: 1, r: 1, material: 'insulating', extra: 'x' },
      { c: 1, r: 1, material: 'standard' },
      { c: GRID_COLS, r: 0 },
      { c: -1, r: 2 },
      { c: 2.5, r: 2 },
      { c: 3, r: 3, material: 'diamond' },
    ],
    fuels: [{ c: 1, r: 1 }, { c: 4, r: 4 }],
    run: { ignited: 'yes', backend: 'quantum', fuelPhase: 'exploding', time: Infinity, latest: { smoke: 'lots' } },
    answerKey: 'secret',
  });
  assert.equal(context.preset, 'custom');
  assert.deepEqual(context.walls, [
    { c: 1, r: 1, material: 'insulating' },
    { c: 3, r: 3, material: 'standard' },
  ]);
  assert.deepEqual(context.fuels, [{ c: 4, r: 4 }]);
  assert.equal(context.run.ignited, false);
  assert.equal(context.run.backend, 'cpu');
  assert.equal(context.run.fuelPhase, 'unlit');
  assert.equal(context.run.time, 0);
  assert.equal(context.run.latest.smoke, 0);
  assert.equal('answerKey' in context, false);
});

test('sanitizer rejects payloads that are not a stove context', () => {
  for (const bad of [null, [], {}, { version: 2, walls: [], fuels: [], run: {} }, { version: 1, walls: {}, fuels: [], run: {} }]) {
    assert.throws(() => sanitizeStoveContext(bad), /INVALID_CONTEXT/);
  }
});

test('question must be 1 to 300 characters after trimming', () => {
  assert.equal(sanitizeQuestion('  為什麼有黑煙？ '), '為什麼有黑煙？');
  assert.throws(() => sanitizeQuestion('   '), /INVALID_QUESTION/);
  assert.throws(() => sanitizeQuestion('煙'.repeat(301)), /INVALID_QUESTION/);
  assert.throws(() => sanitizeQuestion(42), /INVALID_QUESTION/);
});

test('ascii map marks bricks by material and fuel', () => {
  const context = sanitizeStoveContext({
    version: 1,
    walls: [{ c: 0, r: 0, material: 'insulating' }, { c: 1, r: 0, material: 'standard' }, { c: 2, r: 0, material: 'conductive' }],
    fuels: [{ c: 3, r: 0 }],
    run: {},
  });
  const lines = asciiStoveMap(context).split('\n');
  assert.equal(lines.length, GRID_ROWS + 1);
  assert.ok(lines[1].startsWith('I#KF.'));
  assert.equal(lines[1].length, GRID_COLS);
});

test('grounding keeps only cells near walls/fuel and whitelisted metrics', () => {
  const { context } = presetContext('straight');
  const allowed = groundableCells(context);
  const wall = context.walls[0];
  const reply = groundTutorReply({
    guidance: '看 fuelOxygen 和 insulating 的差別',
    question: '你覺得呢？',
    relatedCells: [wall, wall, { c: 0, r: 0 }, { c: 'x', r: 1 }, ...context.walls.slice(1, 6)],
    relatedMetrics: ['smoke', 'smoke', 'apiKey', 'constructor', 'fuelOxygen', 'charRetention'],
    extra: 'dropped',
  }, context);
  assert.equal(allowed.has('0,0'), false);
  assert.equal(reply.relatedCells.length, MAX_RELATED);
  assert.deepEqual(reply.relatedCells[0], { c: wall.c, r: wall.r });
  assert.deepEqual(reply.relatedMetrics, ['smoke', 'fuelOxygen', 'charRetention']);
  assert.equal(reply.guidance.includes('fuelOxygen'), false);
  assert.ok(reply.guidance.includes('「燃料區相對氧氣」'));
  assert.ok(reply.guidance.includes('「低導熱隔熱磚」'));
  assert.equal('extra' in reply, false);
  assert.throws(() => groundTutorReply({ guidance: '', question: 'x' }, context), /INVALID_REPLY/);
});

test('mock tutor walks students through empty scene, unlit stove and burning stove', () => {
  const empty = sanitizeStoveContext({ version: 1, walls: [], fuels: [], run: {} });
  assert.match(mockTutorReply(empty, '怎麼開始').guidance, /稻稈燃料/);

  const { sim, context: unlit } = presetContext('straight');
  const unlitReply = groundTutorReply(mockTutorReply(unlit, '要怎麼做'), unlit);
  assert.match(unlitReply.guidance, /點火/);
  assert.deepEqual(unlitReply.relatedCells, [{ c: unlit.fuels[0].c, r: unlit.fuels[0].r }]);

  sim.ignite();
  for (let i = 0; i < 300; i += 1) sim.step();
  const burning = sanitizeStoveContext(contextFor(sim));
  assert.equal(burning.run.ignited, true);
  const smokeReply = groundTutorReply(mockTutorReply(burning, '為什麼黑煙一直跑出來'), burning);
  assert.deepEqual(smokeReply.relatedMetrics, ['smoke', 'secondaryRate', 'smokeOut']);
  assert.ok(smokeReply.relatedCells.length > 0);
  const stateReply = groundTutorReply(mockTutorReply(burning, '接下來呢'), burning);
  assert.ok(stateReply.guidance.length > 0 && stateReply.question.length > 0);
});

test('tracer questions are answered as airflow markers, not oxygen', () => {
  const { context } = presetContext('straight');
  const reply = mockTutorReply(context, '藍色粒子是氧氣嗎？');
  assert.match(reply.guidance, /不是氧氣/);
  assert.deepEqual(reply.relatedMetrics, ['averageSpeed', 'fuelOxygen']);
});
