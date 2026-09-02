import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFuelState,
  getFuelPhase,
  fuelDiagnostics,
  stepFuelModel,
} from '../src/physics/fuel-model.mjs';

function run(state, seconds, env) {
  const dt = 0.02;
  for (let t = 0; t < seconds; t += dt) stepFuelModel(state, dt, env);
  return state;
}

test('fuel phase distinguishes unlit, sustained burning, and extinguished fuel', () => {
  assert.equal(getFuelPhase({ rawStraw: 1 }), 'unlit');
  assert.equal(getFuelPhase({
    ignited: true,
    ignitionRemaining: 0,
    rawStraw: 0.4,
    char: 0.1,
    volatileGas: 0.2,
    oxygen: 0.8,
    temperature: 420,
  }), 'burning');
  assert.equal(getFuelPhase({
    ignited: true,
    ignitionRemaining: 0,
    rawStraw: 0.4,
    char: 0.1,
    volatileGas: 0.2,
    oxygen: 0.02,
    temperature: 420,
  }), 'extinguished');
  assert.equal(getFuelPhase({
    ignited: true,
    ignitionRemaining: 0,
    rawStraw: 0,
    char: 0,
    volatileGas: 0,
    oxygen: 1,
    temperature: 600,
  }), 'extinguished');
});

test('straw reaction continues after the temporary starter heat ends', () => {
  const s = createFuelState();
  const dt = 0.02;
  for (let t = 0; t < 2.6; t += dt) {
    stepFuelModel(s, dt, { ignitionActive: true, mixing: 1, residenceTime: 1 });
  }
  const rawAfterStarter = s.rawStraw;
  for (let t = 0; t < 2; t += dt) {
    stepFuelModel(s, dt, { ignitionActive: false, mixing: 1, residenceTime: 1 });
  }
  assert.ok(s.rawStraw < rawAfterStarter);
});

test('cold straw does not significantly pyrolyze', () => {
  const s = createFuelState({ temperature: 80, oxygen: 1 });
  run(s, 10, { mixing: 1, residenceTime: 1 });
  assert.ok(s.rawStraw > 0.999);
  assert.ok(s.char < 1e-6);
});

test('hot oxygen-limited condition retains char', () => {
  const s = createFuelState({ temperature: 500, oxygen: 0.08 });
  run(s, 20, { mixing: 0.35, residenceTime: 0.2 });
  const d = fuelDiagnostics(s);
  assert.ok(d.pyrolysisFraction > 0.4);
  assert.ok(s.char > 0.05);
  assert.ok(d.charRetention > 0.35);
});

test('oxygen-rich hot condition oxidizes more char', () => {
  const limited = createFuelState({ temperature: 560, oxygen: 0.08 });
  const rich = createFuelState({ temperature: 560, oxygen: 1 });
  run(limited, 25, { mixing: 0.8, residenceTime: 1 });
  run(rich, 25, { mixing: 0.8, residenceTime: 1 });
  assert.ok(rich.char < limited.char);
  assert.ok(rich.charBurnedTotal > limited.charBurnedTotal);
});

test('smoke is not deleted by oxygen alone', () => {
  const s = createFuelState({ temperature: 25, oxygen: 1 });
  s.smoke = 0.2;
  run(s, 10, { mixing: 1, residenceTime: 1 });
  assert.equal(s.smoke, 0.2);
});

test('secondary smoke oxidation requires heat, oxygen, mixing and residence', () => {
  const weak = createFuelState({ rawStraw: 0, temperature: 650, oxygen: 1 });
  const good = createFuelState({ rawStraw: 0, temperature: 650, oxygen: 1 });
  weak.smoke = 0.2;
  good.smoke = 0.2;
  run(weak, 5, { mixing: 0, residenceTime: 1 });
  run(good, 5, { mixing: 1, residenceTime: 1 });
  assert.equal(weak.smoke, 0.2);
  assert.ok(good.smoke < 0.2);
});

test('mineral matter is conserved separately from organic fuel', () => {
  const s = createFuelState({ temperature: 650, oxygen: 1, mineralMatter: 0.12 });
  run(s, 30, { mixing: 1, residenceTime: 1 });
  const d = fuelDiagnostics(s, { rawStraw: 1, mineralMatter: 0.12 });
  assert.ok(Math.abs(d.mineralError) < 1e-9);
  assert.ok(Math.abs(d.organicError) < 5e-3);
});
