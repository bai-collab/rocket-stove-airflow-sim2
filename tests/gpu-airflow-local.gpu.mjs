import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compute, init, pingPongStorage, storage } from 'vgpu/node';

const readShader = (name) => readFile(
  new URL(`../src/gpu/shaders/airflow/${name}`, import.meta.url),
  'utf8'
);

const [buoyancyShader, advectShader, divergenceShader, pressureShader, projectShader] = await Promise.all([
  readShader('buoyancy.wgsl'),
  readShader('advect-velocity.wgsl'),
  readShader('divergence.wgsl'),
  readShader('pressure-jacobi.wgsl'),
  readShader('project.wgsl'),
]);

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function cpuLocalAirflow({ nx, ny, h, dt, pressureIterations, temperature, solid, velocity }) {
  const n = nx * ny;
  const index = (x, y) => y * nx + x;
  let vel = new Float32Array(velocity);

  for (let i = 0; i < n; i += 1) {
    if (solid[i]) continue;
    const dT = clamp(temperature[i] - 25, 0, 160);
    vel[i * 2 + 1] += -9.81 * (1 / 298.15) * dT * 40 * dt;
  }

  const advected = new Float32Array(n * 2);
  const sample = (px, py, fallback) => {
    if (px < 0 || py < 0 || px >= nx * h || py >= ny * h) return fallback;
    const gx = px / h - 0.5;
    const gy = py / h - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = gx - x0;
    const ty = gy - y0;
    let sx = 0;
    let sy = 0;
    let weight = 0;
    for (let oy = 0; oy <= 1; oy += 1) {
      for (let ox = 0; ox <= 1; ox += 1) {
        const x = x0 + ox;
        const y = y0 + oy;
        if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
        const i = index(x, y);
        if (solid[i]) continue;
        const w = (ox ? tx : 1 - tx) * (oy ? ty : 1 - ty);
        if (w <= 0) continue;
        sx += vel[i * 2] * w;
        sy += vel[i * 2 + 1] * w;
        weight += w;
      }
    }
    return weight > 1e-6 ? [sx / weight, sy / weight] : fallback;
  };

  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const i = index(x, y);
      if (solid[i]) continue;
      const current = [vel[i * 2], vel[i * 2 + 1]];
      const px = (x + 0.5) * h;
      const py = (y + 0.5) * h;
      const [vx, vy] = sample(px - current[0] * dt, py - current[1] * dt, current);
      advected[i * 2] = vx;
      advected[i * 2 + 1] = vy;
    }
  }
  vel = advected;

  const neighbourVelocity = (x, y, axis) => {
    if (x < 0 || y < 0 || x >= nx || y >= ny) return 0;
    const i = index(x, y);
    if (solid[i]) return 0;
    return vel[i * 2 + axis];
  };
  const divergence = new Float32Array(n);
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const i = index(x, y);
      if (solid[i]) continue;
      divergence[i] = (
        neighbourVelocity(x + 1, y, 0) - neighbourVelocity(x - 1, y, 0) +
        neighbourVelocity(x, y + 1, 1) - neighbourVelocity(x, y - 1, 1)
      ) / (2 * h);
    }
  }

  let pressure = new Float32Array(n);
  for (let iter = 0; iter < pressureIterations; iter += 1) {
    const next = new Float32Array(n);
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const i = index(x, y);
        if (solid[i]) continue;
        let sum = 0;
        let count = 0;
        for (const [xx, yy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) {
            count += 1;
            continue;
          }
          const ni = index(xx, yy);
          if (solid[ni]) continue;
          sum += pressure[ni];
          count += 1;
        }
        next[i] = count ? (sum - divergence[i] * h * h) / count : 0;
      }
    }
    pressure = next;
  }

  const projected = new Float32Array(n * 2);
  const neighbourPressure = (x, y, current) => {
    if (x < 0 || y < 0 || x >= nx || y >= ny) return 0;
    const i = index(x, y);
    return solid[i] ? current : pressure[i];
  };
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const i = index(x, y);
      if (solid[i]) continue;
      const pc = pressure[i];
      let ux = vel[i * 2] - (neighbourPressure(x + 1, y, pc) - neighbourPressure(x - 1, y, pc)) / (2 * h);
      let vy = vel[i * 2 + 1] - (neighbourPressure(x, y + 1, pc) - neighbourPressure(x, y - 1, pc)) / (2 * h);
      if (x > 0 && solid[index(x - 1, y)] && ux < 0) ux = 0;
      if (x < nx - 1 && solid[index(x + 1, y)] && ux > 0) ux = 0;
      if (y > 0 && solid[index(x, y - 1)] && vy < 0) vy = 0;
      if (y < ny - 1 && solid[index(x, y + 1)] && vy > 0) vy = 0;
      const speed = Math.hypot(ux, vy);
      if (speed > 180) {
        ux = ux / speed * 180;
        vy = vy / speed * 180;
      }
      projected[i * 2] = ux;
      projected[i * 2 + 1] = vy;
    }
  }
  return { velocity: projected, divergence, pressure };
}

function closeBuffer(buffer) {
  buffer.destroy();
}

test('VGPU local airflow chain matches CPU reference before boundary-flux reduction', async (t) => {
  let gpu;
  try {
    gpu = await init({ adapter: 'auto' });
  } catch (error) {
    t.skip(`No usable Dawn/WebGPU adapter on this runner: ${error instanceof Error ? error.message : error}`);
    return;
  }

  const nx = 6;
  const ny = 5;
  const n = nx * ny;
  const h = 12;
  const dt = 1 / 30;
  const pressureIterations = 8;
  const temperatureData = Float32Array.from({ length: n }, (_, i) => 25 + (i % nx) * 24 + Math.floor(i / nx) * 8);
  const solidData = new Uint32Array(n);
  solidData[2 + 2 * nx] = 1;
  solidData[3 + 2 * nx] = 1;
  const velocityData = new Float32Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    velocityData[i * 2] = ((i % nx) - 2.5) * 0.7;
    velocityData[i * 2 + 1] = (Math.floor(i / nx) - 2) * 0.4;
  }
  for (let i = 0; i < n; i += 1) {
    if (solidData[i]) {
      velocityData[i * 2] = 0;
      velocityData[i * 2 + 1] = 0;
    }
  }

  const expected = cpuLocalAirflow({
    nx, ny, h, dt, pressureIterations,
    temperature: temperatureData,
    solid: solidData,
    velocity: velocityData,
  });

  const temperature = storage(gpu, n * 4, 'read');
  const solid = storage(gpu, n * 4, 'read');
  const velocity = pingPongStorage(gpu, n * 8);
  const pressure = pingPongStorage(gpu, n * 4);
  const divergence = storage(gpu, n * 4, 'read-write');
  const workgroups = Math.ceil(n / 64);

  try {
    temperature.write(temperatureData);
    solid.write(solidData);
    velocity.read.write(velocityData);
    velocity.write.write(velocityData);
    pressure.read.write(new Float32Array(n));
    pressure.write.write(new Float32Array(n));

    compute(gpu, buoyancyShader)
      .set({
        params: { dt, ambient_temperature: 25, max_delta_temperature: 160, acceleration_scale: 40 },
        temperature,
        solid,
        velocity_src: velocity.read,
        velocity_dst: velocity.write,
      })
      .dispatch(workgroups);
    velocity.swap();

    compute(gpu, advectShader)
      .set({ params: { dt, h, nx, ny }, solid, velocity_src: velocity.read, velocity_dst: velocity.write })
      .dispatch(workgroups);
    velocity.swap();

    compute(gpu, divergenceShader)
      .set({ params: { h, nx, ny, _pad: 0 }, solid, velocity: velocity.read, divergence })
      .dispatch(workgroups);

    const jacobi = compute(gpu, pressureShader);
    for (let iter = 0; iter < pressureIterations; iter += 1) {
      jacobi
        .set({
          params: { h, nx, ny, _pad: 0 },
          solid,
          divergence,
          pressure_src: pressure.read,
          pressure_dst: pressure.write,
        })
        .dispatch(workgroups);
      pressure.swap();
    }

    compute(gpu, projectShader)
      .set({
        params: { h, max_speed: 180, nx, ny },
        solid,
        pressure: pressure.read,
        velocity_src: velocity.read,
        velocity_dst: velocity.write,
      })
      .dispatch(workgroups);
    velocity.swap();

    const actualVelocity = new Float32Array(await velocity.read.read());
    const actualDivergence = new Float32Array(await divergence.read());
    const actualPressure = new Float32Array(await pressure.read.read());

    const compare = (actual, wanted, tolerance, label) => {
      assert.equal(actual.length, wanted.length);
      for (let i = 0; i < wanted.length; i += 1) {
        assert.ok(
          Math.abs(actual[i] - wanted[i]) <= tolerance,
          `${label}[${i}] expected ${wanted[i]}, got ${actual[i]}`
        );
      }
    };

    compare(actualDivergence, expected.divergence, 2e-5, 'divergence');
    compare(actualPressure, expected.pressure, 2e-4, 'pressure');
    compare(actualVelocity, expected.velocity, 3e-4, 'velocity');
  } finally {
    [temperature, solid, velocity.read, velocity.write, pressure.read, pressure.write, divergence].forEach(closeBuffer);
    gpu.dispose();
  }
});
