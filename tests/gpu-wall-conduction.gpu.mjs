import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compute, init, pingPongStorage, storage } from 'vgpu/node';
import {
  radiativeHeatTransfer,
  WALL_CONDUCTION_PARAMS,
} from '../src/physics/wall-materials.mjs';

const shader = await readFile(
  new URL('../src/gpu/shaders/combustion/wall-conduction.wgsl', import.meta.url),
  'utf8',
);

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

function expectedThermalExchange({
  nx,
  ny,
  dt,
  solid,
  wallConductivity,
  wallInnerFaceMask,
  temperature,
  wallInnerTemperature,
  wallOuterTemperature,
}) {
  const nextTemperature = new Float32Array(temperature.length);
  const nextWallInnerTemperature = new Float32Array(wallInnerTemperature.length);
  const nextWallOuterTemperature = new Float32Array(wallOuterTemperature.length);
  const index = (x, y) => y * nx + x;
  const directions = [
    { dx: -1, dy: 0, bit: 1 },
    { dx: 1, dy: 0, bit: 2 },
    { dx: 0, dy: -1, bit: 4 },
    { dx: 0, dy: 1, bit: 8 },
  ];
  const harmonic = (a, b) => a <= 0 || b <= 0 ? 0 : (2 * a * b) / (a + b);
  const rate = (conductivity) => clamp(
    Math.max(0, conductivity) / WALL_CONDUCTION_PARAMS.referenceConductivity *
      WALL_CONDUCTION_PARAMS.couplingRate * dt,
    0,
    0.24,
  );
  const slabRate = (conductivity) => clamp(
    Math.max(0, conductivity) / WALL_CONDUCTION_PARAMS.referenceConductivity *
      WALL_CONDUCTION_PARAMS.throughWallRate * dt,
    0,
    0.24,
  );
  const surfaceCapacity = Math.max(
    WALL_CONDUCTION_PARAMS.surfaceHeatCapacity,
    WALL_CONDUCTION_PARAMS.wallHeatCapacity * 0.5,
  );

  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const i = index(x, y);
      if (!solid[i]) {
        let fluidDelta = 0;
        for (const { dx, dy, bit } of directions) {
          const nx0 = x + dx;
          const ny0 = y + dy;
          if (nx0 < 0 || ny0 < 0 || nx0 >= nx || ny0 >= ny) continue;
          const neighbour = index(nx0, ny0);
          if (!solid[neighbour]) continue;
          const solidToFluidBit = x < nx0 ? 1 : x > nx0 ? 2 : y < ny0 ? 4 : 8;
          const isInner = (wallInnerFaceMask[neighbour] & solidToFluidBit) !== 0;
          const surface = isInner
            ? wallInnerTemperature[neighbour]
            : wallOuterTemperature[neighbour];
          fluidDelta += (surface - temperature[i]) * rate(wallConductivity[neighbour]);
          fluidDelta += radiativeHeatTransfer(surface, temperature[i], dt);
        }
        nextTemperature[i] = clamp(
          temperature[i] + fluidDelta,
          25,
          700,
        );
        nextWallInnerTemperature[i] = wallInnerTemperature[i];
        nextWallOuterTemperature[i] = wallOuterTemperature[i];
        continue;
      }

      const inner = wallInnerTemperature[i];
      const outer = wallOuterTemperature[i];
      const conductivity = wallConductivity[i];
      let innerDelta = (outer - inner) * slabRate(conductivity);
      let outerDelta = -innerDelta;
      let hasOuterFluid = false;
      for (const { dx, dy, bit } of directions) {
        const nx0 = x + dx;
        const ny0 = y + dy;
        if (nx0 < 0 || ny0 < 0 || nx0 >= nx || ny0 >= ny) continue;
        const neighbour = index(nx0, ny0);
        if (solid[neighbour]) {
          const response = rate(harmonic(conductivity, wallConductivity[neighbour])) / surfaceCapacity;
          innerDelta += (wallInnerTemperature[neighbour] - inner) * response;
          outerDelta += (wallOuterTemperature[neighbour] - outer) * response;
          continue;
        }

        const isInner = (wallInnerFaceMask[i] & bit) !== 0;
        const surface = isInner ? inner : outer;
        const transfer =
          (surface - temperature[neighbour]) * rate(conductivity) +
          radiativeHeatTransfer(surface, temperature[neighbour], dt);
        if (isInner) innerDelta -= transfer / surfaceCapacity;
        else {
          outerDelta -= transfer / surfaceCapacity;
          hasOuterFluid = true;
        }
      }
      if (!hasOuterFluid) {
        outerDelta -= radiativeHeatTransfer(outer, 25, dt) / surfaceCapacity;
      }
      nextTemperature[i] = temperature[i];
      nextWallInnerTemperature[i] = clamp(inner + innerDelta, 25, 700);
      nextWallOuterTemperature[i] = clamp(outer + outerDelta, 25, 700);
    }
  }

  return {
    temperature: nextTemperature,
    wallInnerTemperature: nextWallInnerTemperature,
    wallOuterTemperature: nextWallOuterTemperature,
  };
}

test('VGPU wall thermal exchange matches the CPU reference formula', async (t) => {
  let gpu;
  try {
    gpu = await init({ adapter: 'auto' });
  } catch (error) {
    t.skip(`No usable Dawn/WebGPU adapter on this runner: ${error instanceof Error ? error.message : error}`);
    return;
  }

  const nx = 4;
  const ny = 3;
  const count = nx * ny;
  const dt = 0.1;
  const solidData = new Uint32Array([
    0, 0, 0, 0,
    0, 1, 0, 0,
    0, 1, 0, 0,
  ]);
  const wallConductivityData = new Float32Array([
    0, 0, 0, 0,
    0, 1.3, 0, 0,
    0, 0.25, 0, 0,
  ]);
  const wallInnerFaceMaskData = new Uint32Array([
    0, 0, 0, 0,
    0, 1, 0, 0,
    0, 1, 0, 0,
  ]);
  const temperatureData = new Float32Array([
    25, 25, 25, 25,
    500, 100, 25, 25,
    400, 150, 25, 25,
  ]);
  const wallInnerTemperatureData = new Float32Array(count).fill(25);
  wallInnerTemperatureData[5] = 100;
  wallInnerTemperatureData[9] = 180;
  const wallOuterTemperatureData = new Float32Array(count).fill(25);
  wallOuterTemperatureData[5] = 200;
  wallOuterTemperatureData[9] = 120;
  const solid = storage(gpu, count * 4, 'read');
  const wallThermalData = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    wallThermalData[i * 2] = wallConductivityData[i] ?? 0;
    wallThermalData[i * 2 + 1] = wallInnerFaceMaskData[i] ?? 0;
  }
  const wallThermal = storage(gpu, count * 8, 'read');
  const temperature = pingPongStorage(gpu, count * 4);
  const wallInnerTemperature = pingPongStorage(gpu, count * 4);
  const wallOuterTemperature = pingPongStorage(gpu, count * 4);

  try {
    solid.write(solidData);
    wallThermal.write(wallThermalData);
    temperature.read.write(temperatureData);
    temperature.write.write(temperatureData);
    wallInnerTemperature.read.write(wallInnerTemperatureData);
    wallInnerTemperature.write.write(wallInnerTemperatureData);
    wallOuterTemperature.read.write(wallOuterTemperatureData);
    wallOuterTemperature.write.write(wallOuterTemperatureData);

    compute(gpu, shader, {
      set: {
        params: {
          dt,
          ambient_temperature: 25,
          max_temperature: 700,
          coupling_rate: WALL_CONDUCTION_PARAMS.couplingRate,
          wall_heat_capacity: WALL_CONDUCTION_PARAMS.wallHeatCapacity,
          surface_heat_capacity: WALL_CONDUCTION_PARAMS.surfaceHeatCapacity,
          through_wall_rate: WALL_CONDUCTION_PARAMS.throughWallRate,
          reference_conductivity: WALL_CONDUCTION_PARAMS.referenceConductivity,
          emissivity: WALL_CONDUCTION_PARAMS.emissivity,
          stefan_boltzmann: WALL_CONDUCTION_PARAMS.stefanBoltzmann,
          radiation_scale: WALL_CONDUCTION_PARAMS.radiationScale,
          nx,
          ny,
          _pad0: 0,
          _pad1: 0,
          _pad2: 0,
        },
        solid,
        wall_thermal: wallThermal,
        temperature_src: temperature.read,
        temperature_dst: temperature.write,
        wall_inner_temperature_src: wallInnerTemperature.read,
        wall_inner_temperature_dst: wallInnerTemperature.write,
        wall_outer_temperature_src: wallOuterTemperature.read,
        wall_outer_temperature_dst: wallOuterTemperature.write,
      },
    }).dispatch(1);
    temperature.swap();
    wallInnerTemperature.swap();
    wallOuterTemperature.swap();

    const actualTemperature = new Float32Array(await temperature.read.read());
    const actualWallInnerTemperature = new Float32Array(await wallInnerTemperature.read.read());
    const actualWallOuterTemperature = new Float32Array(await wallOuterTemperature.read.read());
    const expected = expectedThermalExchange({
      nx,
      ny,
      dt,
      solid: solidData,
      wallConductivity: wallConductivityData,
      wallInnerFaceMask: wallInnerFaceMaskData,
      temperature: temperatureData,
      wallInnerTemperature: wallInnerTemperatureData,
      wallOuterTemperature: wallOuterTemperatureData,
    });

    for (let i = 0; i < count; i += 1) {
      assert.ok(Math.abs(actualTemperature[i] - expected.temperature[i]) < 1e-4,
        `temperature[${i}] actual=${actualTemperature[i]} expected=${expected.temperature[i]}`);
      assert.ok(Math.abs(actualWallInnerTemperature[i] - expected.wallInnerTemperature[i]) < 1e-4,
        `inner[${i}] actual=${actualWallInnerTemperature[i]} expected=${expected.wallInnerTemperature[i]}`);
      assert.ok(Math.abs(actualWallOuterTemperature[i] - expected.wallOuterTemperature[i]) < 1e-4,
        `outer[${i}] actual=${actualWallOuterTemperature[i]} expected=${expected.wallOuterTemperature[i]}`);
    }
    assert.ok(actualTemperature[4] < temperatureData[4]);
    assert.ok(actualTemperature[6] > temperatureData[6]);
    assert.ok(actualWallOuterTemperature[5] !== actualWallInnerTemperature[5]);
  } finally {
    solid.destroy();
    wallThermal.destroy();
    temperature.read.destroy();
    temperature.write.destroy();
    wallInnerTemperature.read.destroy();
    wallInnerTemperature.write.destroy();
    wallOuterTemperature.read.destroy();
    wallOuterTemperature.write.destroy();
    gpu.dispose();
  }
});
