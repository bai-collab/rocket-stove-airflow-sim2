import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compute, draw, effect, frame, init, storage, target } from 'vgpu/node';

const tracerUpdateShader = await readFile(
  new URL('../src/gpu/shaders/tracer/tracer-update.wgsl', import.meta.url),
  'utf8'
);
const fieldRenderShader = await readFile(
  new URL('../src/gpu/shaders/render/field-render.wgsl', import.meta.url),
  'utf8'
);
const packRenderStateShader = await readFile(
  new URL('../src/gpu/shaders/render/pack-render-state.wgsl', import.meta.url),
  'utf8'
);
const packTracerRenderStateShader = await readFile(
  new URL('../src/gpu/shaders/render/pack-tracer-render-state.wgsl', import.meta.url),
  'utf8'
);
const tracerRenderShader = await readFile(
  new URL('../src/gpu/shaders/render/tracer-render.wgsl', import.meta.url),
  'utf8'
);

async function makeGpu(t) {
  try {
    return await init({ adapter: 'auto' });
  } catch (error) {
    t.skip(`No usable Dawn/WebGPU adapter on this runner: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

function close(actual, expected, epsilon = 2e-4) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= epsilon, `index ${i}: expected ${expected[i]}, got ${actual[i]}`);
  }
}

test('VGPU tracer integration uses swept solid collision', async (t) => {
  const gpu = await makeGpu(t);
  if (!gpu) return;

  const nx = 4;
  const ny = 3;
  const h = 12;
  const simWidth = 48;
  const simHeight = 36;
  const dt = 0.25;
  const tracerCount = 3;
  const count = nx * ny;

  const solidData = new Uint32Array(count);
  solidData[1 * nx + 2] = 1;
  const velocityData = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    velocityData[i * 2] = solidData[i] ? 0 : 4;
    velocityData[i * 2 + 1] = 0;
  }
  // The middle tracer crosses the solid cell during this tick but ends in a
  // fluid cell. This catches endpoint-only collision implementations.
  velocityData[(1 * nx + 1) * 2] = 80;
  const tracerData = new Float32Array([
    6, 6, 0, 0,
    23, 18, 0, 0,
    10, 30, 0, 0,
  ]);

  const solid = storage(gpu, count * 4, 'read');
  const velocity = storage(gpu, count * 8, 'read');
  const tracers = storage(gpu, tracerCount * 16, 'read-write');
  try {
    solid.write(solidData);
    velocity.write(velocityData);
    tracers.write(tracerData);
    const pass = compute(gpu, tracerUpdateShader, {
      label: 'test:tracer-update',
      set: {
        params: {
          dt,
          h,
          sim_width: simWidth,
          sim_height: simHeight,
          sim_time: 1.2,
          tracer_count: tracerCount,
          nx,
          ny,
        },
        solid,
        velocity,
        tracers,
      },
    });
    pass.dispatch(1);
    const actual = new Float32Array(await tracers.read());
  close(actual, new Float32Array([
    7, 6, 0, 0,
    23, 18, 0, 0,
    11, 30, 0, 0,
  ]));
  } finally {
    solid.destroy();
    velocity.destroy();
    tracers.destroy();
    gpu.dispose();
  }
});

test('VGPU field and tracer render produce distinct wall, heat/smoke and particle pixels', async (t) => {
  const gpu = await makeGpu(t);
  if (!gpu) return;

  const nx = 4;
  const ny = 3;
  const h = 12;
  const simWidth = 48;
  const simHeight = 36;
  const count = nx * ny;
  const width = 192;
  const height = 144;
  const tracerCount = 2;

  const solidData = new Uint32Array(count);
  solidData[1] = 1;
  const wallMaterialData = new Uint32Array(count);
  wallMaterialData[1] = 3;
  const wallThermalData = new Float32Array(count * 2);
  // Cell 1 has a hot inner face on the left; its top edge is an outer face.
  wallThermalData[1 * 2 + 1] = 1;
  const velocityData = new Float32Array(count * 2);
  velocityData[5 * 2] = 35;
  velocityData[5 * 2 + 1] = -12;
  const temperatureData = new Float32Array(count).fill(25);
  temperatureData[5] = 520;
  temperatureData[9] = 180;
  const wallInnerTemperatureData = new Float32Array(count).fill(25);
  const wallOuterTemperatureData = new Float32Array(count).fill(25);
  wallInnerTemperatureData[1] = 220;
  wallOuterTemperatureData[1] = 180;
  const smokeData = new Float32Array(count);
  smokeData[6] = 0.18;
  const rawData = new Float32Array(count);
  const charData = new Float32Array(count);
  const ashData = new Float32Array(count);
  rawData[8] = 0.5;
  charData[8] = 0.3;
  ashData[8] = 0.05;
  const tracerData = new Float32Array([
    18, 18, 0, 0,
    42, 30, 0, 0,
  ]);

  const solid = storage(gpu, count * 4, 'read');
  const wallMaterial = storage(gpu, count * 4, 'read');
  const velocity = storage(gpu, count * 8, 'read');
  const temperature = storage(gpu, count * 4, 'read');
  const smoke = storage(gpu, count * 4, 'read');
  const raw = storage(gpu, count * 4, 'read');
  const charMass = storage(gpu, count * 4, 'read');
  const ash = storage(gpu, count * 4, 'read');
  const wallInnerTemperature = storage(gpu, count * 4, 'read');
  const wallOuterTemperature = storage(gpu, count * 4, 'read');
  const wallThermal = storage(gpu, count * 8, 'read');
  const renderState = storage(gpu, count * 16, 'read-write');
  const tracers = gpu.device.createBuffer({
    size: tracerCount * 16,
    usage: ['storage', 'vertex', 'copy_dst', 'copy_src'],
    label: 'test:tracer-render-state',
  });
  const screen = target(gpu, { size: [width, height], format: 'rgba8unorm' });

  try {
    solid.write(solidData);
    wallMaterial.write(wallMaterialData);
    velocity.write(velocityData);
    temperature.write(temperatureData);
    smoke.write(smokeData);
    raw.write(rawData);
    charMass.write(charData);
    ash.write(ashData);
    wallInnerTemperature.write(wallInnerTemperatureData);
    wallOuterTemperature.write(wallOuterTemperatureData);
    wallThermal.write(wallThermalData);
    tracers.write(tracerData);

    const pack = compute(gpu, packRenderStateShader, {
      set: {
        params: { cell_count: count, _pad0: 0, _pad1: 0, _pad2: 0 },
        temperature,
        smoke,
        raw_straw: raw,
        char_mass: charMass,
        render_state: renderState,
        solid,
        wall_inner_temperature: wallInnerTemperature,
        wall_outer_temperature: wallOuterTemperature,
      },
    });
    pack.dispatch(1);

    const packTracers = compute(gpu, packTracerRenderStateShader, {
      label: 'test:pack-tracer-render-state',
      set: {
        params: {
          h,
          nx,
          ny,
          tracer_count: tracerCount,
          _pad0: 0,
          _pad1: 0,
          _pad2: 0,
          _pad3: 0,
        },
        temperature,
        tracers,
      },
    });
    packTracers.dispatch(1);

    const field = effect(gpu, fieldRenderShader, {
      set: {
        params: { h, sim_width: simWidth, sim_height: simHeight, ambient_temperature: 25, nx, ny, _pad0: 0, _pad1: 0 },
        solid,
        velocity,
        render_state: renderState,
        ash,
        wall_material: wallMaterial,
        wall_thermal: wallThermal,
        wall_inner_temperature: wallInnerTemperature,
        wall_outer_temperature: wallOuterTemperature,
      },
    });
    const dots = draw(gpu, {
      shader: tracerRenderShader,
      geometry: {
        vertexBuffers: [tracers.gpu],
        vertexBufferLayouts: [{
          arrayStride: 16,
          stepMode: 'instance',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }],
        }],
        vertexCount: 6,
      },
      instances: tracerCount,
      set: {
        params: { sim_width: simWidth, sim_height: simHeight, h, radius: 2, nx, ny, tracer_count: tracerCount, _pad0: 0 },
      },
    });

    field.draw(screen);
    const base = new Uint8Array(await screen.read());
    frame(gpu, (f) => {
      f.pass(screen, (p) => {
        p.draw(field);
        p.draw(dots);
      });
    });
    const combined = new Uint8Array(await screen.read());

    let brownish = 0;
    let warm = 0;
    let dark = 0;
    let smokeCellDark = 0;
    let heatedWall = 0;
    let changed = 0;
    for (let i = 0; i < combined.length; i += 4) {
      const pixel = i / 4;
      const pixelX = pixel % width;
      const pixelY = Math.floor(pixel / width);
    const r = combined[i];
    const g = combined[i + 1];
    const b = combined[i + 2];
      if (r > 100 && g > 40 && b < 130) brownish += 1;
      if (r > g * 1.25 && r > b * 1.4 && r > 130) warm += 1;
      if (r < 150 && g < 150 && b < 160) dark += 1;
      // Cell 6 is intentionally smoke-only: isolate it from the brown wall
      // and fuel colors so the assertion checks the smoke mapping itself.
      if (pixelX >= 96 && pixelX < 144 && pixelY >= 48 && pixelY < 96 && r < 180 && g < 180 && b < 180) {
        smokeCellDark += 1;
      }
      if (pixelX >= 48 && pixelX < 96 && pixelY >= 0 && pixelY < 48 && r > g * 1.35 && r > b * 1.6 && r > 150) {
        heatedWall += 1;
      }
      if (
        Math.abs(r - base[i]) +
        Math.abs(g - base[i + 1]) +
        Math.abs(b - base[i + 2]) > 80
      ) changed += 1;
    }

    const pixelAt = (x, y) => (y * width + x) * 4;
    const innerEdge = pixelAt(51, 24);
    const outerEdge = pixelAt(72, 3);
    assert.ok(
      base[innerEdge] > base[innerEdge + 1] * 1.20 && base[innerEdge] > base[innerEdge + 2] * 1.50,
      `expected red-orange inner face, got ${base[innerEdge]},${base[innerEdge + 1]},${base[innerEdge + 2]}`
    );
    assert.ok(
      base[outerEdge + 1] > base[outerEdge + 2] * 1.20,
      `expected gold outer face, got ${base[outerEdge]},${base[outerEdge + 1]},${base[outerEdge + 2]}`
    );

    assert.ok(brownish > 300, `expected wall/fuel brown pixels, got ${brownish}`);
    assert.ok(warm > 150, `expected hot tracer/temperature pixels, got ${warm}`);
    assert.ok(dark > 150, `expected smoke/char dark pixels, got ${dark}`);
    assert.ok(smokeCellDark > 1500, `expected smoke pixels in smoke cell, got ${smokeCellDark}`);
    assert.ok(heatedWall > 1500, `expected wall temperature tint, got ${heatedWall}`);
    assert.ok(changed > 20, `expected tracer draw to change pixels, got ${changed}`);
  } finally {
    solid.destroy();
    wallMaterial.destroy();
    velocity.destroy();
    temperature.destroy();
    smoke.destroy();
    raw.destroy();
    charMass.destroy();
    ash.destroy();
    wallInnerTemperature.destroy();
    wallOuterTemperature.destroy();
    wallThermal.destroy();
    renderState.destroy();
    tracers.destroy();
    // Offscreen targets are released with the owning VGPU instance. The
    // generic Target interface intentionally has no dispose() method.
    gpu.dispose();
  }
});
