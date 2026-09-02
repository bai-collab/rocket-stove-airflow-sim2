import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CpuRocketSimulation,
  DT,
  NX,
  NY,
} from '../src/simulation/CpuRocketSimulation.mjs';

function run(sim, steps) {
  for (let i = 0; i < steps; i += 1) sim.step(DT);
}

test('stove presets create walls and finite straw fuel', () => {
  const sim = new CpuRocketSimulation();
  assert.ok(sim.walls.length > 0);
  assert.ok(sim.fuels.length > 0);
  const d = sim.diagnostics();
  assert.ok(d.rawStraw > 0);
  assert.ok(d.rawStraw <= sim.fuels.length + 1e-6);
});

test('ignited straw is finite and raw straw decreases after heating', () => {
  const sim = new CpuRocketSimulation();
  sim.loadPreset('straight');
  const before = sim.diagnostics().rawStraw;
  sim.ignite();
  run(sim, 180);
  const after = sim.diagnostics().rawStraw;
  assert.ok(after < before, `expected raw straw to decrease: ${before} -> ${after}`);
  assert.ok(after >= 0);
  assert.ok(Math.abs(sim.diagnostics().organicError) < 1e-4, `organic ledger drifted: ${sim.diagnostics().organicError}`);
});

test('fuel editing updates the baseline without duplicating mass', () => {
  const sim = new CpuRocketSimulation();
  sim.clearScene();

  sim.setToolAt('fuel', 0, 0);
  assert.ok(Math.abs(sim.initialOrganic - 1) < 1e-6);
  assert.ok(Math.abs(sim.initialMineral - 0.12) < 1e-6);

  sim.setToolAt('erase', 0, 0);
  assert.equal(sim.initialOrganic, 0);
  assert.equal(sim.initialMineral, 0);

  sim.setToolAt('fuel', 0, 0);
  assert.ok(Math.abs(sim.initialOrganic - 1) < 1e-6);
  assert.ok(Math.abs(sim.initialMineral - 0.12) < 1e-6);
});

test('opening a wall restores a clean ambient fluid cell', () => {
  const sim = new CpuRocketSimulation();
  sim.clearScene();
  sim.setToolAt('wall', 24, 0);
  sim.temperature[2] = 500;
  sim.oxygen[2] = 0;
  sim.smoke[2] = 0.4;

  sim.setToolAt('erase', 24, 0);
  assert.equal(sim.solid[2], 0);
  assert.equal(sim.temperature[2], 25);
  assert.equal(sim.oxygen[2], 1);
  assert.equal(sim.smoke[2], 0);
});

test('CPU tracers use swept collision instead of endpoint-only collision', () => {
  const sim = new CpuRocketSimulation();
  sim.clearScene();
  sim.setToolAt('wall', 24, 0);

  assert.equal(sim.isSolidPoint(30, 6), true);
  assert.equal(sim.isSolidPoint(60, 6), false);
  assert.equal(sim.segmentHitsSolid(0, 6, 60, 6), true);
});

test('sealed stove does not keep fuel-zone oxygen at ambient after combustion starts', () => {
  const sim = new CpuRocketSimulation();
  sim.loadPreset('sealed');
  const before = sim.diagnostics().fuelOxygen;
  sim.ignite();
  run(sim, 240);
  const after = sim.diagnostics().fuelOxygen;
  assert.ok(before > 0.9);
  assert.ok(after < before - 0.01, `expected oxygen decrease in sealed stove: ${before} -> ${after}`);
});

test('smoke does not disappear merely because time passes', () => {
  const sim = new CpuRocketSimulation();
  sim.clearScene();
  const center = Math.floor(NY / 2) * NX + Math.floor(NX / 2);
  sim.smoke[center] = 0.5;
  sim.running = true;
  run(sim, 90);
  assert.ok(sim.smoke[center] > 0.45, `smoke auto-decayed to ${sim.smoke[center]}`);
});

test('open-boundary projection keeps total inflow and outflow approximately balanced', () => {
  const sim = new CpuRocketSimulation();
  sim.loadPreset('straight');
  sim.ignite();
  run(sim, 120);
  const d = sim.diagnostics();
  assert.ok(Number.isFinite(d.inflow));
  assert.ok(Number.isFinite(d.outflow));
  assert.ok(Math.abs(d.inflow - d.outflow) < 0.05, `flux imbalance: ${d.inflow} vs ${d.outflow}`);
});
