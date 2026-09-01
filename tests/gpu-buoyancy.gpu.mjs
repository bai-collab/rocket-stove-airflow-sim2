import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compute, init, pingPongStorage, storage } from 'vgpu/node';

const shader = await readFile(
  new URL('../src/gpu/shaders/airflow/buoyancy.wgsl', import.meta.url),
  'utf8'
);

function cpuBuoyancy(temperature, solid, velocity, dt) {
  const out = new Float32Array(velocity);
  for (let i = 0; i < temperature.length; i += 1) {
    if (solid[i]) continue;
    const dT = Math.max(0, Math.min(160, temperature[i] - 25));
    const ay = -9.81 * (1 / 298.15) * dT * 40;
    out[i * 2 + 1] += ay * dt;
  }
  return out;
}

test('VGPU buoyancy compute matches CPU reference', async (t) => {
  let gpu;
  try {
    gpu = await init({ adapter: 'auto' });
  } catch (error) {
    t.skip(`No usable Dawn/WebGPU adapter on this runner: ${error instanceof Error ? error.message : error}`);
    return;
  }

  const cellCount = 8;
  const temperatureData = new Float32Array([25, 45, 100, 185, 300, 24, 80, 500]);
  const solidData = new Uint32Array([0, 0, 1, 0, 0, 0, 1, 0]);
  const velocityData = new Float32Array([
    1, 0,
    2, 5,
    3, -7,
    4, 10,
    5, 2,
    6, -1,
    7, 3,
    8, 4,
  ]);
  const dt = 1 / 30;

  const temperature = storage(gpu, cellCount * 4, 'read');
  const solid = storage(gpu, cellCount * 4, 'read');
  const velocity = pingPongStorage(gpu, cellCount * 8);

  try {
    temperature.write(temperatureData);
    solid.write(solidData);
    velocity.read.write(velocityData);
    velocity.write.write(velocityData);

    const pass = compute(gpu, shader, {
      label: 'test:rocket-stove-buoyancy',
      set: {
        params: {
          dt,
          ambient_temperature: 25,
          max_delta_temperature: 160,
          acceleration_scale: 40,
        },
        temperature,
        solid,
        velocity_src: velocity.read,
        velocity_dst: velocity.write,
      },
    });

    pass.dispatch(Math.ceil(cellCount / 64));
    velocity.swap();

    const actual = new Float32Array(await velocity.read.read());
    const expected = cpuBuoyancy(temperatureData, solidData, velocityData, dt);

    assert.equal(actual.length, expected.length);
    for (let i = 0; i < expected.length; i += 1) {
      assert.ok(
        Math.abs(actual[i] - expected[i]) < 1e-4,
        `index ${i}: expected ${expected[i]}, got ${actual[i]}`
      );
    }
  } finally {
    temperature.destroy();
    solid.destroy();
    velocity.read.destroy();
    velocity.write.destroy();
    gpu.dispose();
  }
});
