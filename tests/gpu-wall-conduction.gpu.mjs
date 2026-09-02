import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compute, init, pingPongStorage, storage } from 'vgpu/node';
import { WALL_CONDUCTION_PARAMS } from '../src/physics/wall-materials.mjs';

const shader = await readFile(
  new URL('../src/gpu/shaders/combustion/wall-conduction.wgsl', import.meta.url),
  'utf8',
);

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

function expectedConduction({ nx, ny, dt, solid, wallConductivity, temperature, wallTemperature }) {
  const nextTemperature = new Float32Array(temperature.length);
  const nextWallTemperature = new Float32Array(wallTemperature.length);
  const index = (x, y) => y * nx + x;
  const harmonic = (a, b) => a <= 0 || b <= 0 ? 0 : (2 * a * b) / (a + b);
  const rate = (conductivity) => clamp(
    Math.max(0, conductivity) / WALL_CONDUCTION_PARAMS.referenceConductivity *
      WALL_CONDUCTION_PARAMS.couplingRate * dt,
    0,
    0.24,
  );

  const contribution = (x, y, currentTemperature, currentSolid, currentConductivity) => {
    if (x < 0 || y < 0 || x >= nx || y >= ny) {
      if (!currentSolid) return 0;
      return (25 - currentTemperature) * rate(currentConductivity) / WALL_CONDUCTION_PARAMS.wallHeatCapacity;
    }
    const neighbour = index(x, y);
    const neighbourSolid = Boolean(solid[neighbour]);
    if (!currentSolid && !neighbourSolid) return 0;
    const neighbourTemperature = neighbourSolid ? wallTemperature[neighbour] : temperature[neighbour];
    const conductivity = currentSolid && neighbourSolid
      ? harmonic(currentConductivity, wallConductivity[neighbour])
      : neighbourSolid
        ? wallConductivity[neighbour]
        : currentConductivity;
    const capacity = currentSolid ? WALL_CONDUCTION_PARAMS.wallHeatCapacity : 1;
    return (neighbourTemperature - currentTemperature) * rate(conductivity) / capacity;
  };

  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const i = index(x, y);
      const currentSolid = Boolean(solid[i]);
      const current = currentSolid ? wallTemperature[i] : temperature[i];
      const currentConductivity = currentSolid ? wallConductivity[i] : 0;
      const delta =
        contribution(x - 1, y, current, currentSolid, currentConductivity) +
        contribution(x + 1, y, current, currentSolid, currentConductivity) +
        contribution(x, y - 1, current, currentSolid, currentConductivity) +
        contribution(x, y + 1, current, currentSolid, currentConductivity);
      const next = clamp(current + delta, 25, 700);
      if (currentSolid) {
        nextTemperature[i] = temperature[i];
        nextWallTemperature[i] = next;
      } else {
        nextTemperature[i] = next;
        nextWallTemperature[i] = wallTemperature[i];
      }
    }
  }

  return { temperature: nextTemperature, wallTemperature: nextWallTemperature };
}

test('VGPU wall conduction matches the CPU reference formula', async (t) => {
  let gpu;
  try {
    gpu = await init({ adapter: 'auto' });
  } catch (error) {
    t.skip(`No usable Dawn/WebGPU adapter on this runner: ${error instanceof Error ? error.message : error}`);
    return;
  }

  const nx = 3;
  const ny = 2;
  const count = nx * ny;
  const dt = 0.1;
  const solidData = new Uint32Array([0, 1, 0, 0, 0, 0]);
  const wallConductivityData = new Float32Array([0, 1.3, 0, 0, 0, 0]);
  const temperatureData = new Float32Array([500, 25, 25, 25, 25, 25]);
  const wallTemperatureData = new Float32Array(count).fill(25);
  const solid = storage(gpu, count * 4, 'read');
  const wallConductivity = storage(gpu, count * 4, 'read');
  const temperature = pingPongStorage(gpu, count * 4);
  const wallTemperature = pingPongStorage(gpu, count * 4);

  try {
    solid.write(solidData);
    wallConductivity.write(wallConductivityData);
    temperature.read.write(temperatureData);
    temperature.write.write(temperatureData);
    wallTemperature.read.write(wallTemperatureData);
    wallTemperature.write.write(wallTemperatureData);

    compute(gpu, shader, {
      set: {
        params: {
          dt,
          ambient_temperature: 25,
          max_temperature: 700,
          coupling_rate: WALL_CONDUCTION_PARAMS.couplingRate,
          wall_heat_capacity: WALL_CONDUCTION_PARAMS.wallHeatCapacity,
          reference_conductivity: WALL_CONDUCTION_PARAMS.referenceConductivity,
          nx,
          ny,
        },
        solid,
        wall_conductivity: wallConductivity,
        temperature_src: temperature.read,
        temperature_dst: temperature.write,
        wall_temperature_src: wallTemperature.read,
        wall_temperature_dst: wallTemperature.write,
      },
    }).dispatch(1);
    temperature.swap();
    wallTemperature.swap();

    const actualTemperature = new Float32Array(await temperature.read.read());
    const actualWallTemperature = new Float32Array(await wallTemperature.read.read());
    const expected = expectedConduction({
      nx,
      ny,
      dt,
      solid: solidData,
      wallConductivity: wallConductivityData,
      temperature: temperatureData,
      wallTemperature: wallTemperatureData,
    });

    for (let i = 0; i < count; i += 1) {
      assert.ok(Math.abs(actualTemperature[i] - expected.temperature[i]) < 1e-4);
      assert.ok(Math.abs(actualWallTemperature[i] - expected.wallTemperature[i]) < 1e-4);
    }
    assert.ok(actualTemperature[0] < temperatureData[0]);
    assert.ok(actualWallTemperature[1] > wallTemperatureData[1]);
  } finally {
    solid.destroy();
    wallConductivity.destroy();
    temperature.read.destroy();
    temperature.write.destroy();
    wallTemperature.read.destroy();
    wallTemperature.write.destroy();
    gpu.dispose();
  }
});
