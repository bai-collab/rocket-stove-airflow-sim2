struct WallConductionParams {
  dt: f32,
  ambient_temperature: f32,
  max_temperature: f32,
  coupling_rate: f32,
  wall_heat_capacity: f32,
  reference_conductivity: f32,
  nx: u32,
  ny: u32,
};

@group(0) @binding(0) var<uniform> params: WallConductionParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> wall_conductivity: array<f32>;
@group(0) @binding(3) var<storage, read> temperature_src: array<f32>;
@group(0) @binding(4) var<storage, read_write> temperature_dst: array<f32>;
@group(0) @binding(5) var<storage, read> wall_temperature_src: array<f32>;
@group(0) @binding(6) var<storage, read_write> wall_temperature_dst: array<f32>;

fn cell_index(x: i32, y: i32) -> u32 {
  return u32(y) * params.nx + u32(x);
}

fn in_grid(x: i32, y: i32) -> bool {
  return x >= 0i && y >= 0i && x < i32(params.nx) && y < i32(params.ny);
}

fn harmonic_conductivity(a: f32, b: f32) -> f32 {
  if (a <= 0.0 || b <= 0.0) {
    return 0.0;
  }
  return (2.0 * a * b) / (a + b);
}

fn interface_rate(conductivity: f32) -> f32 {
  return clamp(
    max(0.0, conductivity) / max(params.reference_conductivity, 1e-6) *
      params.coupling_rate * params.dt,
    0.0,
    0.24,
  );
}

fn contribution(
  x: i32,
  y: i32,
  current_temperature: f32,
  current_is_solid: bool,
  current_conductivity: f32,
) -> f32 {
  if (!in_grid(x, y)) {
    if (!current_is_solid) {
      return 0.0;
    }
    return (
      params.ambient_temperature - current_temperature
    ) * interface_rate(current_conductivity) / max(params.wall_heat_capacity, 1.0);
  }

  let neighbour = cell_index(x, y);
  let neighbour_is_solid = solid[neighbour] != 0u;
  if (!current_is_solid && !neighbour_is_solid) {
    return 0.0;
  }

  let neighbour_temperature = select(
    temperature_src[neighbour],
    wall_temperature_src[neighbour],
    neighbour_is_solid,
  );
  var conductivity = current_conductivity;
  if (current_is_solid && neighbour_is_solid) {
    conductivity = harmonic_conductivity(
      current_conductivity,
      wall_conductivity[neighbour],
    );
  } else if (neighbour_is_solid) {
    conductivity = wall_conductivity[neighbour];
  }

  let capacity = select(1.0, max(params.wall_heat_capacity, 1.0), current_is_solid);
  return (neighbour_temperature - current_temperature) * interface_rate(conductivity) / capacity;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let count = params.nx * params.ny;
  if (i >= count) {
    return;
  }

  let x = i32(i % params.nx);
  let y = i32(i / params.nx);
  let current_is_solid = solid[i] != 0u;
  let current_temperature = select(
    temperature_src[i],
    wall_temperature_src[i],
    current_is_solid,
  );
  let current_conductivity = select(0.0, wall_conductivity[i], current_is_solid);
  let delta =
    contribution(x - 1i, y, current_temperature, current_is_solid, current_conductivity) +
    contribution(x + 1i, y, current_temperature, current_is_solid, current_conductivity) +
    contribution(x, y - 1i, current_temperature, current_is_solid, current_conductivity) +
    contribution(x, y + 1i, current_temperature, current_is_solid, current_conductivity);
  let next_temperature = clamp(
    current_temperature + delta,
    params.ambient_temperature,
    params.max_temperature,
  );

  if (current_is_solid) {
    temperature_dst[i] = temperature_src[i];
    wall_temperature_dst[i] = next_temperature;
  } else {
    temperature_dst[i] = next_temperature;
    wall_temperature_dst[i] = wall_temperature_src[i];
  }
}
