import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compute, init, pingPongStorage, storage } from 'vgpu/node';

const readShader = (name) => readFile(
  new URL(`../src/gpu/shaders/airflow/${name}`, import.meta.url),
  'utf8'
);

const [statsShader, reduceShader, correctShader] = await Promise.all([
  readShader('boundary-flux-stats.wgsl'),
  readShader('reduce-vec2.wgsl'),
  readShader('boundary-flux-correct.wgsl'),
]);

function cpuBalance(nx, ny, solid, velocity) {
  const index = (x, y) => y * nx + x;
  const out = new Float32Array(velocity);
  let net = 0;
  let count = 0;

  for (let x = 0; x < nx; x += 1) {
    const top = index(x, 0);
    const bottom = index(x, ny - 1);
    if (!solid[top]) {
      net += -out[top * 2 + 1];
      count += 1;
    }
    if (!solid[bottom]) {
      net += out[bottom * 2 + 1];
      count += 1;
    }
  }
  for (let y = 0; y < ny; y += 1) {
    const left = index(0, y);
    const right = index(nx - 1, y);
    if (!solid[left]) {
      net += -out[left * 2];
      count += 1;
    }
    if (!solid[right]) {
      net += out[right * 2];
      count += 1;
    }
  }

  if (!count || Math.abs(net) <= 1e-5) return { velocity: out, net, count };
  const correction = net / count;
  for (let x = 0; x < nx; x += 1) {
    const top = index(x, 0);
    const bottom = index(x, ny - 1);
    if (!solid[top]) out[top * 2 + 1] += correction;
    if (!solid[bottom]) out[bottom * 2 + 1] -= correction;
  }
  for (let y = 0; y < ny; y += 1) {
    const left = index(0, y);
    const right = index(nx - 1, y);
    if (!solid[left]) out[left * 2] += correction;
    if (!solid[right]) out[right * 2] -= correction;
  }
  return { velocity: out, net, count };
}

function netBoundaryFlux(nx, ny, solid, velocity) {
  const index = (x, y) => y * nx + x;
  let net = 0;
  for (let x = 0; x < nx; x += 1) {
    const top = index(x, 0);
    const bottom = index(x, ny - 1);
    if (!solid[top]) net += -velocity[top * 2 + 1];
    if (!solid[bottom]) net += velocity[bottom * 2 + 1];
  }
  for (let y = 0; y < ny; y += 1) {
    const left = index(0, y);
    const right = index(nx - 1, y);
    if (!solid[left]) net += -velocity[left * 2];
    if (!solid[right]) net += velocity[right * 2];
  }
  return net;
}

test('VGPU boundary reduction/correction matches CPU open-boundary balance', async (t) => {
  let gpu;
  try {
    gpu = await init({ adapter: 'auto' });
  } catch (error) {
    t.skip(`No usable Dawn/WebGPU adapter on this runner: ${error instanceof Error ? error.message : error}`);
    return;
  }

  const nx = 5;
  const ny = 4;
  const n = nx * ny;
  const solidData = new Uint32Array(n);
  solidData[1] = 1;               // top boundary blocked
  solidData[(ny - 1) * nx + 3] = 1; // bottom boundary blocked
  const velocityData = new Float32Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    velocityData[i * 2] = (i % nx) * 0.8 - 0.9;
    velocityData[i * 2 + 1] = Math.floor(i / nx) * 0.55 - 0.35;
    if (solidData[i]) {
      velocityData[i * 2] = 0;
      velocityData[i * 2 + 1] = 0;
    }
  }

  const expected = cpuBalance(nx, ny, solidData, velocityData);
  assert.ok(Math.abs(expected.net) > 1e-4, 'fixture must contain an initial flux imbalance');

  const solid = storage(gpu, n * 4, 'read');
  const velocity = pingPongStorage(gpu, n * 8);
  const stats = pingPongStorage(gpu, n * 8);
  const workgroups = Math.ceil(n / 64);

  try {
    solid.write(solidData);
    velocity.read.write(velocityData);
    velocity.write.write(velocityData);
    stats.read.write(new Float32Array(n * 2));
    stats.write.write(new Float32Array(n * 2));

    compute(gpu, statsShader)
      .set({
        params: { nx, ny, _pad0: 0, _pad1: 0 },
        solid,
        velocity: velocity.read,
        stats: stats.write,
      })
      .dispatch(workgroups);
    stats.swap();

    const reduce = compute(gpu, reduceShader);
    let inputCount = n;
    while (inputCount > 1) {
      const outputCount = Math.ceil(inputCount / 2);
      reduce
        .set({
          params: { input_count: inputCount, _pad0: 0, _pad1: 0, _pad2: 0 },
          src: stats.read,
          dst: stats.write,
        })
        .dispatch(Math.ceil(outputCount / 64));
      stats.swap();
      inputCount = outputCount;
    }

    const totals = new Float32Array(await stats.read.read());
    assert.ok(Math.abs(totals[0] - expected.net) < 1e-5, `net expected ${expected.net}, got ${totals[0]}`);
    assert.equal(Math.round(totals[1]), expected.count);

    compute(gpu, correctShader)
      .set({
        params: { nx, ny, _pad0: 0, _pad1: 0 },
        solid,
        reduced_stats: stats.read,
        velocity_src: velocity.read,
        velocity_dst: velocity.write,
      })
      .dispatch(workgroups);
    velocity.swap();

    const actual = new Float32Array(await velocity.read.read());
    assert.equal(actual.length, expected.velocity.length);
    for (let i = 0; i < actual.length; i += 1) {
      assert.ok(
        Math.abs(actual[i] - expected.velocity[i]) < 2e-5,
        `velocity[${i}] expected ${expected.velocity[i]}, got ${actual[i]}`
      );
    }
    assert.ok(Math.abs(netBoundaryFlux(nx, ny, solidData, actual)) < 2e-5);
  } finally {
    solid.destroy();
    velocity.read.destroy();
    velocity.write.destroy();
    stats.read.destroy();
    stats.write.destroy();
    gpu.dispose();
  }
});
