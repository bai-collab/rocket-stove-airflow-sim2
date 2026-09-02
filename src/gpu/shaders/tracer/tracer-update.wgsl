struct TracerParams {
  dt: f32,
  h: f32,
  sim_width: f32,
  sim_height: f32,
  sim_time: f32,
  tracer_count: u32,
  nx: u32,
  ny: u32,
};

@group(0) @binding(0) var<uniform> params: TracerParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> velocity: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> tracers: array<vec2f>;

fn in_canvas(p: vec2f) -> bool {
  return p.x >= 0.0 && p.y >= 0.0 && p.x < params.sim_width && p.y < params.sim_height;
}

fn grid_index_from_point(p: vec2f) -> u32 {
  // Dawn/WebGPU may round a point that should be exactly on a cell edge to
  // the fluid side. Keep collision classification stable at solid boundaries.
  let epsilon = max(params.h * 1e-4, 1e-4);
  let gx = min(params.nx - 1u, u32(floor((p.x + epsilon) / params.h)));
  let gy = min(params.ny - 1u, u32(floor((p.y + epsilon) / params.h)));
  return gy * params.nx + gx;
}

fn is_solid_point(p: vec2f) -> bool {
  if (!in_canvas(p)) {
    return false;
  }
  return solid[grid_index_from_point(p)] != 0u;
}

// Swept collision prevents a fast tracer from tunnelling through a thin wall.
fn segment_hits_solid(origin: vec2f, destination: vec2f) -> bool {
  let delta = destination - origin;
  let distance = length(delta);
  let step_length = max(params.h * 0.35, 0.0001);
  let steps = max(1u, u32(ceil(distance / step_length)));
  var s = 1u;
  loop {
    if (s > steps) {
      break;
    }
    let t = f32(s) / f32(steps);
    let point = origin + delta * t;
    if (is_solid_point(point)) {
      return true;
    }
    s += 1u;
  }
  return false;
}

fn sample_velocity(p: vec2f) -> vec2f {
  if (!in_canvas(p)) {
    return vec2f(0.0);
  }

  let gx = p.x / params.h - 0.5;
  let gy = p.y / params.h - 0.5;
  let x0 = i32(floor(gx));
  let y0 = i32(floor(gy));
  let tx = gx - f32(x0);
  let ty = gy - f32(y0);

  var sum = vec2f(0.0);
  var weight = 0.0;
  for (var oy = 0i; oy <= 1i; oy += 1i) {
    for (var ox = 0i; ox <= 1i; ox += 1i) {
      let x = x0 + ox;
      let y = y0 + oy;
      if (x < 0 || y < 0 || x >= i32(params.nx) || y >= i32(params.ny)) {
        continue;
      }
      let i = u32(y) * params.nx + u32(x);
      if (solid[i] != 0u) {
        continue;
      }
      let wx = select(1.0 - tx, tx, ox == 1i);
      let wy = select(1.0 - ty, ty, oy == 1i);
      let w = wx * wy;
      if (w <= 0.0) {
        continue;
      }
      sum += velocity[i] * w;
      weight += w;
    }
  }
  if (weight > 1e-6) {
    return sum / weight;
  }
  return vec2f(0.0);
}

fn find_fluid_point_near(p: vec2f) -> vec2f {
  let gx = i32(min(params.nx - 1u, u32(floor(clamp(p.x, 0.0, params.sim_width - 1e-3) / params.h))));
  let gy = i32(min(params.ny - 1u, u32(floor(clamp(p.y, 0.0, params.sim_height - 1e-3) / params.h))));
  for (var radius = 1i; radius < 8i; radius += 1i) {
    let min_y = max(0i, gy - radius);
    let max_y = min(i32(params.ny) - 1i, gy + radius);
    let min_x = max(0i, gx - radius);
    let max_x = min(i32(params.nx) - 1i, gx + radius);
    for (var y = min_y; y <= max_y; y += 1i) {
      for (var x = min_x; x <= max_x; x += 1i) {
        let i = u32(y) * params.nx + u32(x);
        if (solid[i] == 0u) {
          return vec2f((f32(x) + 0.5) * params.h, (f32(y) + 0.5) * params.h);
        }
      }
    }
  }
  return vec2f(-1.0);
}

fn inflow_candidate_count() -> u32 {
  var count = 0u;
  for (var x = 0u; x < params.nx; x += 2u) {
    let top = x;
    let bottom = (params.ny - 1u) * params.nx + x;
    if (solid[top] == 0u && velocity[top].y > 0.0) { count += 1u; }
    if (solid[bottom] == 0u && velocity[bottom].y < 0.0) { count += 1u; }
  }
  for (var y = 0u; y < params.ny; y += 2u) {
    let left = y * params.nx;
    let right = left + params.nx - 1u;
    if (solid[left] == 0u && velocity[left].x > 0.0) { count += 1u; }
    if (solid[right] == 0u && velocity[right].x < 0.0) { count += 1u; }
  }
  return count;
}

fn inflow_candidate_at(candidate_index: u32) -> vec2f {
  var cursor = 0u;
  for (var x = 0u; x < params.nx; x += 2u) {
    let top = x;
    let bottom = (params.ny - 1u) * params.nx + x;
    if (solid[top] == 0u && velocity[top].y > 0.0) {
      if (cursor == candidate_index) { return vec2f((f32(x) + 0.5) * params.h, 2.0); }
      cursor += 1u;
    }
    if (solid[bottom] == 0u && velocity[bottom].y < 0.0) {
      if (cursor == candidate_index) { return vec2f((f32(x) + 0.5) * params.h, params.sim_height - 2.0); }
      cursor += 1u;
    }
  }
  for (var y = 0u; y < params.ny; y += 2u) {
    let left = y * params.nx;
    let right = left + params.nx - 1u;
    if (solid[left] == 0u && velocity[left].x > 0.0) {
      if (cursor == candidate_index) { return vec2f(2.0, (f32(y) + 0.5) * params.h); }
      cursor += 1u;
    }
    if (solid[right] == 0u && velocity[right].x < 0.0) {
      if (cursor == candidate_index) { return vec2f(params.sim_width - 2.0, (f32(y) + 0.5) * params.h); }
      cursor += 1u;
    }
  }
  return vec2f(2.0, params.sim_height * 0.5);
}

fn respawn(p: vec2f) -> vec2f {
  let count = inflow_candidate_count();
  if (count == 0u) {
    return vec2f(2.0, clamp(p.y, 2.0, params.sim_height - 2.0));
  }
  let key = u32(max(0.0, floor(params.sim_time * 97.0 + p.x + p.y)));
  return inflow_candidate_at(key % count);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.tracer_count) {
    return;
  }

  var p = tracers[i];
  if (is_solid_point(p)) {
    let relocated = find_fluid_point_near(p);
    p = select(respawn(p), relocated, relocated.x >= 0.0);
  }

  let vel = sample_velocity(p);
  let next = p + vel * params.dt;
  if (!in_canvas(next)) {
    tracers[i] = respawn(p);
    return;
  }
  if (!segment_hits_solid(p, next)) {
    tracers[i] = next;
    return;
  }

  let try_x = vec2f(next.x, p.y);
  let try_y = vec2f(p.x, next.y);
  if (!segment_hits_solid(p, try_x)) {
    p.x = try_x.x;
  } else if (!segment_hits_solid(p, try_y)) {
    p.y = try_y.y;
  }
  tracers[i] = p;
}
