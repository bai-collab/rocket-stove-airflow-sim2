struct GridParams {
  h: f32,
  nx: u32,
  ny: u32,
  _pad: u32,
};

@group(0) @binding(0) var<uniform> params: GridParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> divergence: array<f32>;
@group(0) @binding(3) var<storage, read> pressure_src: array<f32>;
@group(0) @binding(4) var<storage, read_write> pressure_dst: array<f32>;

fn grid_index(x: u32, y: u32) -> u32 {
  return y * params.nx + x;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&pressure_src)) {
    return;
  }
  if (solid[i] != 0u) {
    pressure_dst[i] = 0.0;
    return;
  }

  let x = i32(i % params.nx);
  let y = i32(i / params.nx);
  var sum = 0.0;
  var count = 0.0;

  let nx_values = array<i32, 4>(x - 1, x + 1, x, x);
  let ny_values = array<i32, 4>(y, y, y - 1, y + 1);
  for (var n = 0u; n < 4u; n += 1u) {
    let nx = nx_values[n];
    let ny = ny_values[n];
    if (nx < 0 || ny < 0 || nx >= i32(params.nx) || ny >= i32(params.ny)) {
      count += 1.0;
      continue;
    }
    let ni = grid_index(u32(nx), u32(ny));
    if (solid[ni] != 0u) {
      continue;
    }
    sum += pressure_src[ni];
    count += 1.0;
  }

  pressure_dst[i] = select(
    0.0,
    (sum - divergence[i] * params.h * params.h) / count,
    count > 0.0
  );
}
