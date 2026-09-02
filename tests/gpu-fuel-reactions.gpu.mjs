import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compute, init, storage } from 'vgpu/node';
import {
  DEFAULT_FUEL_PARAMS,
  createFuelState,
  stepPrimaryFuelModel,
  stepSecondarySmokeOxidation,
} from '../src/physics/fuel-model.mjs';

const pyrolysisShader = await readFile(new URL('../src/gpu/shaders/fuel/pyrolysis-pass.wgsl', import.meta.url), 'utf8');
const volatileShader = await readFile(new URL('../src/gpu/shaders/fuel/volatile-combustion.wgsl', import.meta.url), 'utf8');
const charShader = await readFile(new URL('../src/gpu/shaders/fuel/char-oxidation-pass.wgsl', import.meta.url), 'utf8');
const coolingShader = await readFile(new URL('../src/gpu/shaders/combustion/cooling-residence.wgsl', import.meta.url), 'utf8');
const secondaryShader = await readFile(new URL('../src/gpu/shaders/combustion/secondary-combustion.wgsl', import.meta.url), 'utf8');

const FUEL = DEFAULT_FUEL_PARAMS;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const close = (actual, expected, epsilon = 3e-5, label = 'value') => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: expected ${expected}, got ${actual}`);
};

async function makeGpu(t) {
  try {
    return await init({ adapter: 'auto' });
  } catch (error) {
    t.skip(`No usable Dawn/WebGPU adapter on this runner: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

test('VGPU pyrolysis + volatile combustion + char oxidation match CPU Physics v3', async (t) => {
  const gpu = await makeGpu(t);
  if (!gpu) return;
  const dt = 0.1;
  const nx = 1;
  const ny = 1;

  const fuelMask = storage(gpu, 4, 'read');
  const velocity = storage(gpu, 8, 'read');
  const raw = storage(gpu, 4, 'read-write');
  const charMass = storage(gpu, 4, 'read-write');
  const volatileGas = storage(gpu, 4, 'read-write');
  const oxygen = storage(gpu, 4, 'read-write');
  const temperature = storage(gpu, 4, 'read-write');
  const exhaust = storage(gpu, 4, 'read-write');
  const smoke = storage(gpu, 4, 'read-write');
  const mineral = storage(gpu, 4, 'read-write');
  const ash = storage(gpu, 4, 'read-write');

  try {
    fuelMask.write(new Uint32Array([1]));
    velocity.write(new Float32Array([0, 0]));
    raw.write(new Float32Array([1]));
    charMass.write(new Float32Array([0]));
    volatileGas.write(new Float32Array([0]));
    oxygen.write(new Float32Array([1]));
    temperature.write(new Float32Array([420]));
    exhaust.write(new Float32Array([0]));
    smoke.write(new Float32Array([0]));
    mineral.write(new Float32Array([0.12]));
    ash.write(new Float32Array([0]));

    compute(gpu, pyrolysisShader, {
      set: {
        params: {
          dt, ignition_active: 0,
          pyrolysis_start_temperature: FUEL.pyrolysisStartTemperature,
          pyrolysis_full_temperature: FUEL.pyrolysisFullTemperature,
          pyrolysis_rate: FUEL.pyrolysisRate,
          char_yield: FUEL.charYield,
          volatile_yield: FUEL.volatileYield,
          ignition_heat_rate: FUEL.ignitionHeatRate,
          ambient_temperature: FUEL.ambientTemperature,
          max_temperature: FUEL.maxTemperature,
          cell_count: 1, _pad0: 0,
        },
        fuel_mask: fuelMask, raw_straw: raw, char_mass: charMass, volatile_gas: volatileGas, temperature,
      },
    }).dispatch(1);

    compute(gpu, volatileShader, {
      set: {
        params: {
          dt, h: 12,
          burn_start_temperature: FUEL.volatileBurnStartTemperature,
          burn_full_temperature: FUEL.volatileBurnFullTemperature,
          burn_rate: FUEL.volatileBurnRate,
          oxygen_use: FUEL.volatileOxygenUse,
          heat_gain: FUEL.volatileHeatGain,
          clean_smoke_yield: FUEL.cleanSmokeYield,
          dirty_smoke_yield: FUEL.dirtySmokeYield,
          max_temperature: FUEL.maxTemperature,
          ambient_temperature: FUEL.ambientTemperature,
          nx, ny,
        },
        fuel_mask: fuelMask, velocity, volatile_gas: volatileGas, oxygen, temperature,
        exhaust_gas: exhaust, smoke,
      },
    }).dispatch(1);

    compute(gpu, charShader, {
      set: {
        params: {
          dt,
          oxidation_rate: FUEL.charOxidationRate,
          oxygen_use: FUEL.charOxygenUse,
          heat_gain: FUEL.charHeatGain,
          ash_exposure_per_char: FUEL.ashExposurePerCharOxidized,
          max_temperature: FUEL.maxTemperature,
          ambient_temperature: FUEL.ambientTemperature,
          cell_count: 1, _pad0: 0,
        },
        fuel_mask: fuelMask, char_mass: charMass, oxygen, temperature, exhaust_gas: exhaust,
        mineral_matter: mineral, ash,
      },
    }).dispatch(1);

    const expected = createFuelState({ rawStraw: 1, mineralMatter: 0.12, oxygen: 1, temperature: 420 });
    stepPrimaryFuelModel(expected, dt, { mixing: 0.16 }, FUEL);

    close(new Float32Array(await raw.read())[0], expected.rawStraw, 4e-5, 'rawStraw');
    close(new Float32Array(await charMass.read())[0], expected.char, 4e-5, 'char');
    close(new Float32Array(await volatileGas.read())[0], expected.volatileGas, 4e-5, 'volatileGas');
    close(new Float32Array(await oxygen.read())[0], expected.oxygen, 4e-5, 'oxygen');
    close(new Float32Array(await temperature.read())[0], expected.temperature, 4e-5, 'temperature');
    close(new Float32Array(await exhaust.read())[0], expected.exhaustGas, 4e-5, 'exhaust');
    close(new Float32Array(await smoke.read())[0], expected.smoke, 4e-5, 'smoke');
    close(new Float32Array(await mineral.read())[0], expected.mineralMatter, 4e-5, 'mineral');
    close(new Float32Array(await ash.read())[0], expected.ash, 4e-5, 'ash');
  } finally {
    for (const buffer of [fuelMask, velocity, raw, charMass, volatileGas, oxygen, temperature, exhaust, smoke, mineral, ash]) buffer.destroy();
    gpu.dispose();
  }
});

test('VGPU cooling and secondary residence update match CPU order', async (t) => {
  const gpu = await makeGpu(t);
  if (!gpu) return;
  const dt = 0.2;
  const nx = 2;
  const ny = 1;
  const count = 2;
  const solid = storage(gpu, count * 4, 'read');
  const velocity = storage(gpu, count * 8, 'read');
  const temperature = storage(gpu, count * 4, 'read-write');
  const oxygen = storage(gpu, count * 4, 'read-write');
  const smoke = storage(gpu, count * 4, 'read-write');
  const volatileGas = storage(gpu, count * 4, 'read-write');
  const residence = storage(gpu, count * 4, 'read-write');
  try {
    solid.write(new Uint32Array([0, 0]));
    velocity.write(new Float32Array([2, 0, 0.2, 0]));
    temperature.write(new Float32Array([300, 280]));
    oxygen.write(new Float32Array([1.1, -0.1]));
    smoke.write(new Float32Array([0.002, -0.01]));
    volatileGas.write(new Float32Array([0.01, 0]));
    residence.write(new Float32Array([0.4, 0.4]));

    compute(gpu, coolingShader, {
      set: {
        params: {
          dt, ambient_temperature: 25, max_temperature: 700, cooling_rate: 0.018,
          residence_max: 2, residence_decay_rate: 1.6, reactive_threshold: 0.0005,
          moving_threshold: 1.5, hot_threshold: 260, _pad0: 0, nx, ny,
        },
        solid, velocity, temperature, oxygen, smoke, volatile_gas: volatileGas, residence,
      },
    }).dispatch(1);

    const expectedT0 = clamp(300 + (25 - 300) * 0.018 * dt, 25, 700);
    const expectedT1 = clamp(280 + (25 - 280) * 0.018 * dt, 25, 700);
    const tActual = new Float32Array(await temperature.read());
    const oActual = new Float32Array(await oxygen.read());
    const sActual = new Float32Array(await smoke.read());
    const vActual = new Float32Array(await volatileGas.read());
    const rActual = new Float32Array(await residence.read());
    close(tActual[0], expectedT0); close(tActual[1], expectedT1);
    close(oActual[0], 1); close(oActual[1], 0);
    close(sActual[0], 0.002); close(sActual[1], 0);
    close(vActual[0], 0.01); close(vActual[1], 0);
    close(rActual[0], 0.6); close(rActual[1], Math.max(0, 0.4 - dt * 1.6));
  } finally {
    for (const buffer of [solid, velocity, temperature, oxygen, smoke, volatileGas, residence]) buffer.destroy();
    gpu.dispose();
  }
});

test('VGPU secondary smoke oxidation matches CPU and emits reaction statistics', async (t) => {
  const gpu = await makeGpu(t);
  if (!gpu) return;
  const nx = 3;
  const ny = 3;
  const h = 12;
  const dt = 0.1;
  const count = nx * ny;
  const center = 4;
  const solid = storage(gpu, count * 4, 'read');
  const velocity = storage(gpu, count * 8, 'read');
  const smoke = storage(gpu, count * 4, 'read-write');
  const oxygen = storage(gpu, count * 4, 'read-write');
  const exhaust = storage(gpu, count * 4, 'read-write');
  const temperature = storage(gpu, count * 4, 'read-write');
  const residence = storage(gpu, count * 4, 'read');
  const stats = storage(gpu, count * 8, 'read-write');
  try {
    solid.write(new Uint32Array(count));
    const velocities = new Float32Array(count * 2);
    velocities[center * 2] = 10;
    velocity.write(velocities);
    const s = new Float32Array(count); s[center] = 0.2; smoke.write(s);
    const o = new Float32Array(count); o.fill(1); o[center] = 0.8; oxygen.write(o);
    const e = new Float32Array(count); exhaust.write(e);
    const temp = new Float32Array(count); temp.fill(25); temp[center] = 500; temperature.write(temp);
    const r = new Float32Array(count); r[center] = 1; residence.write(r);
    stats.write(new Float32Array(count * 2));

    compute(gpu, secondaryShader, {
      set: {
        params: {
          dt, h,
          oxidation_rate: FUEL.secondarySmokeOxidationRate,
          oxygen_use: FUEL.secondarySmokeOxygenUse,
          heat_gain: FUEL.secondaryHeatGain,
          max_temperature: FUEL.maxTemperature,
          ambient_temperature: FUEL.ambientTemperature,
          residence_scale: 0.75, _pad0: 0, nx, ny, _pad1: 0, _pad2: 0,
        },
        solid, velocity, smoke, oxygen, exhaust_gas: exhaust, temperature, residence, reaction_stats: stats,
      },
    }).dispatch(1);

    const expected = createFuelState({ rawStraw: 0, mineralMatter: 0, oxygen: 0.8, temperature: 500 });
    expected.smoke = 0.2;
    const mixing = clamp(0.16 + 10 / 80, 0.16, 1);
    stepSecondarySmokeOxidation(expected, dt, { mixing, residenceTime: 1 }, FUEL);
    close(new Float32Array(await smoke.read())[center], expected.smoke, 4e-5, 'secondary smoke');
    close(new Float32Array(await oxygen.read())[center], expected.oxygen, 4e-5, 'secondary oxygen');
    close(new Float32Array(await exhaust.read())[center], expected.exhaustGas, 4e-5, 'secondary exhaust');
    close(new Float32Array(await temperature.read())[center], expected.temperature, 4e-5, 'secondary temperature');
    close(new Float32Array(await stats.read())[center * 2], expected.smokeOxidizedTotal, 4e-5, 'secondary stats');
  } finally {
    for (const buffer of [solid, velocity, smoke, oxygen, exhaust, temperature, residence, stats]) buffer.destroy();
    gpu.dispose();
  }
});
