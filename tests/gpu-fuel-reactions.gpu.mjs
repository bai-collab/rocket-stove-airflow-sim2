import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compute, init, storage } from 'vgpu/node';

const pyrolysisShader = await readFile(new URL('../src/gpu/shaders/fuel/pyrolysis-pass.wgsl', import.meta.url), 'utf8');
const volatileShader = await readFile(new URL('../src/gpu/shaders/fuel/volatile-combustion.wgsl', import.meta.url), 'utf8');
const charShader = await readFile(new URL('../src/gpu/shaders/fuel/char-oxidation-pass.wgsl', import.meta.url), 'utf8');
const coolingShader = await readFile(new URL('../src/gpu/shaders/combustion/cooling-residence.wgsl', import.meta.url), 'utf8');
const secondaryShader = await readFile(new URL('../src/gpu/shaders/combustion/secondary-combustion.wgsl', import.meta.url), 'utf8');

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smooth = (x) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};
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
          dt, ignition_active: 0, pyrolysis_start_temperature: 140, pyrolysis_full_temperature: 420,
          pyrolysis_rate: 0.22, char_yield: 0.34, volatile_yield: 0.66, ignition_heat_rate: 230,
          ambient_temperature: 25, max_temperature: 700, cell_count: 1, _pad0: 0,
        },
        fuel_mask: fuelMask, raw_straw: raw, char_mass: charMass, volatile_gas: volatileGas, temperature,
      },
    }).dispatch(1);

    compute(gpu, volatileShader, {
      set: {
        params: {
          dt, h: 12, burn_start_temperature: 180, burn_full_temperature: 520, burn_rate: 2.2,
          oxygen_use: 0.34, heat_gain: 185, clean_smoke_yield: 0.02, dirty_smoke_yield: 0.58,
          max_temperature: 700, nx, ny,
        },
        fuel_mask: fuelMask, velocity, volatile_gas: volatileGas, oxygen, temperature,
        exhaust_gas: exhaust, smoke,
      },
    }).dispatch(1);

    compute(gpu, charShader, {
      set: {
        params: {
          dt, oxidation_rate: 0.5, oxygen_use: 0.44, heat_gain: 135,
          ash_exposure_per_char: 0.18, max_temperature: 700, cell_count: 1, _pad0: 0,
        },
        fuel_mask: fuelMask, char_mass: charMass, oxygen, temperature, exhaust_gas: exhaust,
        mineral_matter: mineral, ash,
      },
    }).dispatch(1);

    let eRaw = 1;
    let eChar = 0;
    let eVol = 0;
    let eO2 = 1;
    let eT = 420;
    let eExhaust = 0;
    let eSmoke = 0;
    let eMineral = 0.12;
    let eAsh = 0;

    const converted = Math.min(eRaw, eRaw * 0.22 * smooth((eT - 140) / (420 - 140)) * dt);
    eRaw -= converted;
    eChar += converted * 0.34;
    eVol += converted * 0.66;

    const burnTemp = smooth((eT - 180) / (520 - 180));
    const o2Factor = clamp((eO2 - 0.04) / 0.72);
    const mixing = 0.16;
    const completeness = clamp(burnTemp * o2Factor * (0.25 + 0.75 * mixing));
    const burned = Math.min(eVol, eVol * 2.2 * completeness * dt, eO2 / 0.34);
    eVol -= burned;
    eO2 = clamp(eO2 - burned * 0.34);
    eExhaust += burned;
    eT = clamp(eT + burned * 185, 25, 700);
    const smokeYield = 0.02 + 0.58 * Math.pow(1 - completeness, 1.35);
    const smokeSource = Math.min(eVol, eVol * smokeYield * smooth((eT - 110) / 180) * dt);
    eVol -= smokeSource;
    eSmoke += smokeSource;

    const charTemp = smooth((eT - 260) / 360);
    const charO2 = clamp((eO2 - 0.06) / 0.70);
    const oxidized = Math.min(eChar, eChar * 0.5 * charTemp * charO2 * dt, eO2 / 0.44);
    eChar -= oxidized;
    eO2 = clamp(eO2 - oxidized * 0.44);
    eExhaust += oxidized;
    eT = clamp(eT + oxidized * 135, 25, 700);
    const exposed = Math.min(eMineral, oxidized * 0.18);
    eMineral -= exposed;
    eAsh += exposed;

    close(new Float32Array(await raw.read())[0], eRaw, 4e-5, 'rawStraw');
    close(new Float32Array(await charMass.read())[0], eChar, 4e-5, 'char');
    close(new Float32Array(await volatileGas.read())[0], eVol, 4e-5, 'volatileGas');
    close(new Float32Array(await oxygen.read())[0], eO2, 4e-5, 'oxygen');
    close(new Float32Array(await temperature.read())[0], eT, 4e-5, 'temperature');
    close(new Float32Array(await exhaust.read())[0], eExhaust, 4e-5, 'exhaust');
    close(new Float32Array(await smoke.read())[0], eSmoke, 4e-5, 'smoke');
    close(new Float32Array(await mineral.read())[0], eMineral, 4e-5, 'mineral');
    close(new Float32Array(await ash.read())[0], eAsh, 4e-5, 'ash');
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
          dt, h, oxidation_rate: 0.55, oxygen_use: 0.14, heat_gain: 85,
          max_temperature: 700, residence_scale: 0.75, _pad0: 0, nx, ny, _pad1: 0, _pad2: 0,
        },
        solid, velocity, smoke, oxygen, exhaust_gas: exhaust, temperature, residence, reaction_stats: stats,
      },
    }).dispatch(1);

    const mixing = clamp(0.16 + 10 / 80, 0.16, 1);
    const secondary = smooth((500 - 260) / 300) * clamp((0.8 - 0.08) / 0.65) * mixing * clamp(1 / 0.75);
    const oxidized = Math.min(0.2, 0.2 * 0.55 * secondary * dt, 0.8 / 0.14);
    close(new Float32Array(await smoke.read())[center], 0.2 - oxidized, 4e-5, 'secondary smoke');
    close(new Float32Array(await oxygen.read())[center], clamp(0.8 - oxidized * 0.14), 4e-5, 'secondary oxygen');
    close(new Float32Array(await exhaust.read())[center], oxidized, 4e-5, 'secondary exhaust');
    close(new Float32Array(await temperature.read())[center], clamp(500 + oxidized * 85, 25, 700), 4e-5, 'secondary temperature');
    close(new Float32Array(await stats.read())[center * 2], oxidized, 4e-5, 'secondary stats');
  } finally {
    for (const buffer of [solid, velocity, smoke, oxygen, exhaust, temperature, residence, stats]) buffer.destroy();
    gpu.dispose();
  }
});
