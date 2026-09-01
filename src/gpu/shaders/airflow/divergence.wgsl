struct GridParams {
  h: f32,
  nx: u32,
  ny: u32,
  _pad: u32,
};

@group(0) @binding(0) var<uniform> params: GridParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> velocity: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> divergence: array<f32>;

fn grid_index(x: u32, y: u32) -> u32 {
  return y * params.nx + x;
}

fn neighbour_component(x: i32, y: i32, axis: u32) -> f32 {
  if (x < 0 || y < 0 || x >= i32(params.nx) || y >= i32(params.ny)) {
    return 0.0;
  }
  let i = grid_index(u32(x), u32(y));
  if (solid[i] != 0u) {
    return 0.0;
  }
  return select(velocity[i].x, velocity[i].y, axis == 1u);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&divergence)) {
    return;
  }
  if (solid[i] != 0u) {
    divergence[i] = 0.0;
    return;
  }

  let x = i32(i % params.nx);
  let y = i32(i / params.nx);
  let u_l = neighbour_component(x - 1, y, 0u);
  let u_r = neighbour_component(x + 1, y, 0u);
  let v_u = neighbour_component(x, y - 1, 1u);
  let v_d = neighbour_component(x, y + 1, 1u);
  divergence[i] = (u_r - u_l + v_d - v_u) / (2.0 * params.h);
}
