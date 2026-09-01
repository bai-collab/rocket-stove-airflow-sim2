struct ScalarAdvectionParams {
  dt: f32,
  h: f32,
  fallback: f32,
  trace_step: f32,
  nx: u32,
  ny: u32,
  wall_safe: u32,
  _pad: u32,
};

@group(0) @binding(0) var<uniform> params: ScalarAdvectionParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> velocity: array<vec2f>;
@group(0) @binding(3) var<storage, read> scalar_src: array<f32>;
@group(0) @binding(4) var<storage, read_write> scalar_dst: array<f32>;

fn cell_index(x: u32, y: u32) -> u32 {
  return y * params.nx + x;
}

fn in_canvas(p: vec2f) -> bool {
  return p.x >= 0.0 && p.y >= 0.0 &&
    p.x < f32(params.nx) * params.h &&
    p.y < f32(params.ny) * params.h;
}

fn is_solid_point(p: vec2f) -> bool {
  if (!in_canvas(p)) {
    return false;
  }
  let x = min(u32(floor(p.x / params.h)), params.nx - 1u);
  let y = min(u32(floor(p.y / params.h)), params.ny - 1u);
  return solid[cell_index(x, y)] != 0u;
}

// 0 = fluid, 1 = solid, 2 = outside canvas.
fn trace_status(from: vec2f, to: vec2f) -> u32 {
  let delta = to - from;
  let distance = length(delta);
  let steps = max(1u, u32(ceil(distance / max(params.trace_step, 0.0001))));
  var s = 1u;
  loop {
    if (s > steps) {
      break;
    }
    let t = f32(s) / f32(steps);
    let p = from + delta * t;
    if (!in_canvas(p)) {
      return 2u;
    }
    if (is_solid_point(p)) {
      return 1u;
    }
    s += 1u;
  }
  return 0u;
}

fn sample_scalar(p: vec2f, fallback: f32) -> f32 {
  if (!in_canvas(p)) {
    return fallback;
  }

  let gx = p.x / params.h - 0.5;
  let gy = p.y / params.h - 0.5;
  let x0 = i32(floor(gx));
  let y0 = i32(floor(gy));
  let tx = gx - f32(x0);
  let ty = gy - f32(y0);

  var sum = 0.0;
  var weight = 0.0;
  var oy = 0i;
  loop {
    if (oy > 1i) { break; }
    var ox = 0i;
    loop {
      if (ox > 1i) { break; }
      let x = x0 + ox;
      let y = y0 + oy;
      if (x >= 0i && y >= 0i && x < i32(params.nx) && y < i32(params.ny)) {
        let i = cell_index(u32(x), u32(y));
        if (solid[i] == 0u) {
          let wx = select(1.0 - tx, tx, ox == 1i);
          let wy = select(1.0 - ty, ty, oy == 1i);
          let w = wx * wy;
          if (w > 0.0) {
            sum += scalar_src[i] * w;
            weight += w;
          }
        }
      }
      ox += 1i;
    }
    oy += 1i;
  }

  return select(fallback, sum / weight, weight > 0.000001);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let count = params.nx * params.ny;
  if (i >= count) {
    return;
  }
  if (solid[i] != 0u) {
    scalar_dst[i] = params.fallback;
    return;
  }

  let x = i % params.nx;
  let y = i / params.nx;
  let from = vec2f((f32(x) + 0.5) * params.h, (f32(y) + 0.5) * params.h);
  let back = from - velocity[i] * params.dt;

  if (params.wall_safe != 0u) {
    let status = trace_status(from, back);
    if (status == 1u) {
      scalar_dst[i] = scalar_src[i];
      return;
    }
    if (status == 2u) {
      scalar_dst[i] = params.fallback;
      return;
    }
  }

  scalar_dst[i] = sample_scalar(back, scalar_src[i]);
}
