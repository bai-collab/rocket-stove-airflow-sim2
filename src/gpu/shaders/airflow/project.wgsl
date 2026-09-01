struct GridParams {
  h: f32,
  max_speed: f32,
  nx: u32,
  ny: u32,
};

@group(0) @binding(0) var<uniform> params: GridParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> pressure: array<f32>;
@group(0) @binding(3) var<storage, read> velocity_src: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> velocity_dst: array<vec2f>;

fn grid_index(x: u32, y: u32) -> u32 {
  return y * params.nx + x;
}

fn neighbour_pressure(x: i32, y: i32, current: f32) -> f32 {
  if (x < 0 || y < 0 || x >= i32(params.nx) || y >= i32(params.ny)) {
    return 0.0;
  }
  let i = grid_index(u32(x), u32(y));
  return select(pressure[i], current, solid[i] != 0u);
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

  let x = i32(i % params.nx);
  let y = i32(i / params.nx);
  let pc = pressure[i];
  let p_l = neighbour_pressure(x - 1, y, pc);
  let p_r = neighbour_pressure(x + 1, y, pc);
  let p_u = neighbour_pressure(x, y - 1, pc);
  let p_d = neighbour_pressure(x, y + 1, pc);

  var next = velocity_src[i];
  next.x -= (p_r - p_l) / (2.0 * params.h);
  next.y -= (p_d - p_u) / (2.0 * params.h);

  if (x > 0 && solid[grid_index(u32(x - 1), u32(y))] != 0u && next.x < 0.0) {
    next.x = 0.0;
  }
  if (x + 1 < i32(params.nx) && solid[grid_index(u32(x + 1), u32(y))] != 0u && next.x > 0.0) {
    next.x = 0.0;
  }
  if (y > 0 && solid[grid_index(u32(x), u32(y - 1))] != 0u && next.y < 0.0) {
    next.y = 0.0;
  }
  if (y + 1 < i32(params.ny) && solid[grid_index(u32(x), u32(y + 1))] != 0u && next.y > 0.0) {
    next.y = 0.0;
  }

  let speed = length(next);
  if (speed > params.max_speed) {
    next = next / speed * params.max_speed;
  }
  velocity_dst[i] = next;
}
