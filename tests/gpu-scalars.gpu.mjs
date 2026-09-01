import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compute, init, pingPongStorage, storage } from 'vgpu/node';

const advectShader = await readFile(
  new URL('../src/gpu/shaders/scalar/advect-scalar.wgsl', import.meta.url),
  'utf8'
);
const boundaryShader = await readFile(
  new URL('../src/gpu/shaders/scalar/open-boundary-exchange.wgsl', import.meta.url),
  'utf8'
);
const reduceShader = await readFile(
  new URL('../src/gpu/shaders/airflow/reduce-vec2.wgsl', import.meta.url),
  'utf8'
);

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

function sampleScalar(src, solid, nx, ny, h, px, py, fallback) {
  if (px < 0 || py < 0 || px >= nx * h || py >= ny * h) return fallback;
  const gx = px / h - 0.5;
  const gy = py / h - 0.5;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = gx - x0;
  const ty = gy - y0;
  let sum = 0;
  let weight = 0;
  for (let oy = 0; oy <= 1; oy += 1) {
    for (let ox = 0; ox <= 1; ox += 1) {
      const x = x0 + ox;
      const y = y0 + oy;
      if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
      const i = y * nx + x;
      if (solid[i]) continue;
      const w = (ox ? tx : 1 - tx) * (oy ? ty : 1 - ty);
      if (w <= 0) continue;
      sum += src[i] * w;
      weight += w;
    }
  }
  return weight > 1e-6 ? sum / weight : fallback;
}

function isSolidPoint(solid, nx, ny, h, px, py) {
  if (px < 0 || py < 0 || px >= nx * h || py >= ny * h) return false;
  const x = Math.min(nx - 1, Math.floor(px / h));
  const y = Math.min(ny - 1, Math.floor(py / h));
  return solid[y * nx + x] !== 0;
}

function traceStatus(solid, nx, ny, h, traceStep, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(distance / traceStep));
  for (let s = 1; s <= steps; s += 1) {
    const t = s / steps;
    const x = x0 + dx * t;
    const y = y0 + dy * t;
    if (x < 0 || y < 0 || x >= nx * h || y >= ny * h) return 'outside';
    if (isSolidPoint(solid, nx, ny, h, x, y)) return 'solid';
  }
  return 'fluid';
}

function cpuAdvectScalar(src, solid, velocity, nx, ny, h, dt, fallback, traceStep) {
  const dst = new Float32Array(src.length);
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const i = y * nx + x;
      if (solid[i]) {
        dst[i] = fallback;
        continue;
      }
      const px = (x + 0.5) * h;
      const py = (y + 0.5) * h;
      const bx = px - velocity[i * 2] * dt;
      const by = py - velocity[i * 2 + 1] * dt;
      const status = traceStatus(solid, nx, ny, h, traceStep, px, py, bx, by);
      if (status === 'solid') {
        dst[i] = src[i];
        continue;
      }
      if (status === 'outside') {
        dst[i] = fallback;
        continue;
      }
      dst[i] = sampleScalar(src, solid, nx, ny, h, bx, by, src[i]);
    }
  }
  return dst;
}

function cpuBoundaryExchange(state, solid, velocity, nx, ny, h, dt) {
  const temperature = new Float32Array(state.temperature);
  const oxygen = new Float32Array(state.oxygen);
  const smoke = new Float32Array(state.smoke);
  const volatileGas = new Float32Array(state.volatileGas);
  const exhaustGas = new Float32Array(state.exhaustGas);
  let smokeOut = 0;
  let volatileOut = 0;

  const freshen = (i, rate) => {
    const k = clamp(rate * dt, 0, 1);
    temperature[i] += (25 - temperature[i]) * k;
    oxygen[i] += (1 - oxygen[i]) * k;
    smoke[i] *= 1 - k;
    volatileGas[i] *= 1 - k;
    exhaustGas[i] *= 1 - k;
  };
  const recordOut = (i, outward) => {
    if (outward <= 0 || solid[i]) return;
    smokeOut += smoke[i] * outward * dt / h;
    volatileOut += volatileGas[i] * outward * dt / h;
  };

  for (let x = 0; x < nx; x += 1) {
    const top = x;
    const bottom = (ny - 1) * nx + x;
    if (!solid[top]) {
      const v = velocity[top * 2 + 1];
      if (v > 0) freshen(top, Math.max(1, v / h));
      else recordOut(top, -v);
    }
    if (!solid[bottom]) {
      const v = velocity[bottom * 2 + 1];
      if (v < 0) freshen(bottom, Math.max(1, -v / h));
      else recordOut(bottom, v);
    }
  }
  for (let y = 0; y < ny; y += 1) {
    const left = y * nx;
    const right = y * nx + nx - 1;
    if (!solid[left]) {
      const u = velocity[left * 2];
      if (u > 0) freshen(left, Math.max(1, u / h));
      else recordOut(left, -u);
    }
    if (!solid[right]) {
      const u = velocity[right * 2];
      if (u < 0) freshen(right, Math.max(1, -u / h));
      else recordOut(right, u);
    }
  }

  return { temperature, oxygen, smoke, volatileGas, exhaustGas, smokeOut, volatileOut };
}

function assertFloatArrayClose(actual, expected, epsilon = 2e-4) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= epsilon,
      `index ${i}: expected ${expected[i]}, got ${actual[i]}`
    );
  }
}

async function makeGpu(t) {
  try {
    return await init({ adapter: 'auto' });
  } catch (error) {
    t.skip(`No usable Dawn/WebGPU adapter on this runner: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

test('VGPU wall-safe scalar advection matches CPU and isolates sealed cells', async (t) => {
  const gpu = await makeGpu(t);
  if (!gpu) return;

  const nx = 6;
  const ny = 5;
  const h = 12;
  const dt = 0.35;
  const traceStep = Math.max(2, h * 0.35);
  const count = nx * ny;
  const fallback = 1;

  const solidData = new Uint32Array(count);
  // Small wall ring around the center cell (2,2).
  for (const [x, y] of [[1, 1], [2, 1], [3, 1], [1, 2], [3, 2], [1, 3], [2, 3], [3, 3]]) {
    solidData[y * nx + x] = 1;
  }

  const srcData = new Float32Array(count);
  const velocityData = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) srcData[i] = 0.1 + i * 0.027;
  // Interior transport plus several paths that hit walls or leave the canvas.
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const i = y * nx + x;
      velocityData[i * 2] = x === 0 ? 55 : 4 + y;
      velocityData[i * 2 + 1] = y === 0 ? 48 : -3 + x * 0.7;
    }
  }
  const sealedCenter = 2 * nx + 2;
  velocityData[sealedCenter * 2] = 80;
  velocityData[sealedCenter * 2 + 1] = 0;

  const solid = storage(gpu, count * 4, 'read');
  const velocity = storage(gpu, count * 8, 'read');
  const src = storage(gpu, count * 4, 'read');
  const dst = storage(gpu, count * 4, 'read-write');

  try {
    solid.write(solidData);
    velocity.write(velocityData);
    src.write(srcData);
    dst.write(new Float32Array(count));

    const pass = compute(gpu, advectShader, {
      label: 'test:scalar-advection',
      set: {
        params: { dt, h, fallback, trace_step: traceStep, nx, ny, wall_safe: 1, _pad: 0 },
        solid,
        velocity,
        scalar_src: src,
        scalar_dst: dst,
      },
    });
    pass.dispatch(Math.ceil(count / 64));

    const actual = new Float32Array(await dst.read());
    const expected = cpuAdvectScalar(srcData, solidData, velocityData, nx, ny, h, dt, fallback, traceStep);
    assertFloatArrayClose(actual, expected);
    assert.ok(Math.abs(actual[sealedCenter] - srcData[sealedCenter]) < 1e-5, 'sealed center must keep its scalar when backtrace hits wall');
    assert.notEqual(actual[sealedCenter], fallback, 'sealed center must not receive ambient fallback through the wall');
  } finally {
    solid.destroy();
    velocity.destroy();
    src.destroy();
    dst.destroy();
    gpu.dispose();
  }
});

test('VGPU open-boundary scalar exchange and outflow totals match CPU', async (t) => {
  const gpu = await makeGpu(t);
  if (!gpu) return;

  const nx = 5;
  const ny = 4;
  const h = 12;
  const dt = 0.2;
  const count = nx * ny;
  const solidData = new Uint32Array(count);
  solidData[2] = 1; // blocked top boundary cell

  const velocityData = new Float32Array(count * 2);
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const i = y * nx + x;
      velocityData[i * 2] = (x === 0 ? (y % 2 === 0 ? 18 : -12) : x === nx - 1 ? (y % 2 === 0 ? -15 : 10) : 0);
      velocityData[i * 2 + 1] = (y === 0 ? (x % 2 === 0 ? 14 : -11) : y === ny - 1 ? (x % 2 === 0 ? -16 : 9) : 0);
    }
  }

  const state = {
    temperature: Float32Array.from({ length: count }, (_, i) => 60 + i * 4),
    oxygen: Float32Array.from({ length: count }, (_, i) => 0.25 + (i % 6) * 0.08),
    smoke: Float32Array.from({ length: count }, (_, i) => 0.02 + i * 0.006),
    volatileGas: Float32Array.from({ length: count }, (_, i) => 0.03 + i * 0.004),
    exhaustGas: Float32Array.from({ length: count }, (_, i) => 0.01 + i * 0.003),
  };
  const expected = cpuBoundaryExchange(state, solidData, velocityData, nx, ny, h, dt);

  const solid = storage(gpu, count * 4, 'read');
  const velocity = storage(gpu, count * 8, 'read');
  const temperature = storage(gpu, count * 4, 'read-write');
  const oxygen = storage(gpu, count * 4, 'read-write');
  const smoke = storage(gpu, count * 4, 'read-write');
  const volatileGas = storage(gpu, count * 4, 'read-write');
  const exhaustGas = storage(gpu, count * 4, 'read-write');
  const outflow = pingPongStorage(gpu, count * 8);

  try {
    solid.write(solidData);
    velocity.write(velocityData);
    temperature.write(state.temperature);
    oxygen.write(state.oxygen);
    smoke.write(state.smoke);
    volatileGas.write(state.volatileGas);
    exhaustGas.write(state.exhaustGas);
    outflow.read.write(new Float32Array(count * 2));
    outflow.write.write(new Float32Array(count * 2));

    const boundary = compute(gpu, boundaryShader, {
      label: 'test:scalar-boundary',
      set: {
        params: { dt, h, ambient_temperature: 25, ambient_oxygen: 1, nx, ny, _pad0: 0, _pad1: 0 },
        solid,
        velocity,
        temperature,
        oxygen,
        smoke,
        volatile_gas: volatileGas,
        exhaust_gas: exhaustGas,
        outflow_stats: outflow.write,
      },
    });
    boundary.dispatch(Math.ceil(count / 64));
    outflow.swap();

    const reduce = compute(gpu, reduceShader, { label: 'test:scalar-outflow-reduce' });
    let inputCount = count;
    while (inputCount > 1) {
      const outputCount = Math.ceil(inputCount / 2);
      reduce
        .set({
          params: { input_count: inputCount, _pad0: 0, _pad1: 0, _pad2: 0 },
          src: outflow.read,
          dst: outflow.write,
        })
        .dispatch(Math.ceil(outputCount / 64));
      outflow.swap();
      inputCount = outputCount;
    }

    assertFloatArrayClose(new Float32Array(await temperature.read()), expected.temperature);
    assertFloatArrayClose(new Float32Array(await oxygen.read()), expected.oxygen);
    assertFloatArrayClose(new Float32Array(await smoke.read()), expected.smoke);
    assertFloatArrayClose(new Float32Array(await volatileGas.read()), expected.volatileGas);
    assertFloatArrayClose(new Float32Array(await exhaustGas.read()), expected.exhaustGas);

    const totals = new Float32Array(await outflow.read.read());
    assert.ok(Math.abs((totals[0] ?? 0) - expected.smokeOut) < 2e-4, `smokeOut expected ${expected.smokeOut}, got ${totals[0]}`);
    assert.ok(Math.abs((totals[1] ?? 0) - expected.volatileOut) < 2e-4, `volatileOut expected ${expected.volatileOut}, got ${totals[1]}`);
  } finally {
    solid.destroy();
    velocity.destroy();
    temperature.destroy();
    oxygen.destroy();
    smoke.destroy();
    volatileGas.destroy();
    exhaustGas.destroy();
    outflow.read.destroy();
    outflow.write.destroy();
    gpu.dispose();
  }
});
