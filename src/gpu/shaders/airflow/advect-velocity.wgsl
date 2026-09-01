struct GridParams {
  dt: f32,
  h: f32,
  nx: u32,
  ny: u32,
};

@group(0) @binding(0) var<uniform> params: GridParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> velocity_src: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> velocity_dst: array<vec2f>;

fn grid_index(x: u32, y: u32) -> u32 {
  return y * params.nx + x;
}

fn sample_velocity(px: f32, py: f32, fallback: vec2f) -> vec2f {
  let width = f32(params.nx) * params.h;
  let height = f32(params.ny) * params.h;
  if (px < 0.0 || py < 0.0 || px >= width || py >= height) {
    return fallback;
  }

  let gx = px / params.h - 0.5;
  let gy = py / params.h - 0.5;
  let x0 = i32(floor(gx));
  let y0 = i32(floor(gy));
  let tx = gx - f32(x0);
  let ty = gy - f32(y0);
  var sum = vec2f(0.0);
  var weight_sum = 0.0;

  for (var oy = 0i; oy <= 1i; oy += 1i) {
    for (var ox = 0i; ox <= 1i; ox += 1i) {
      let x = x0 + ox;
      let y = y0 + oy;
      if (x < 0 || y < 0 || x >= i32(params.nx) || y >= i32(params.ny)) {
        continue;
      }
      let i = grid_index(u32(x), u32(y));
      if (solid[i] != 0u) {
        continue;
      }
      let wx = select(1.0 - tx, tx, ox != 0i);
      let wy = select(1.0 - ty, ty, oy != 0i);
      let w = wx * wy;
      if (w <= 0.0) {
        continue;
      }
      sum += velocity_src[i] * w;
      weight_sum += w;
    }
  }

  return select(fallback, sum / weight_sum, weight_sum > 1e-6);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&velocity_src)) {
    return;
  }
  if (solid[i] != 0u) {
    velocity_dst[i] = vec2f(0.0);
    return;
  }

  let x = i % params.nx;
  let y = i / params.nx;
  let current = velocity_src[i];
  let px = (f32(x) + 0.5) * params.h;
  let py = (f32(y) + 0.5) * params.h;
  let bx = px - current.x * params.dt;
  let by = py - current.y * params.dt;
  velocity_dst[i] = sample_velocity(bx, by, current);
}
