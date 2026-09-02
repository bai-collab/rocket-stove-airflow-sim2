struct WallThermalParams {
  dt: f32,
  ambient_temperature: f32,
  max_temperature: f32,
  coupling_rate: f32,
  wall_heat_capacity: f32,
  surface_heat_capacity: f32,
  through_wall_rate: f32,
  reference_conductivity: f32,
  emissivity: f32,
  stefan_boltzmann: f32,
  radiation_scale: f32,
  nx: u32,
  ny: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: WallThermalParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> wall_thermal: array<vec2f>;
@group(0) @binding(3) var<storage, read> temperature_src: array<f32>;
@group(0) @binding(4) var<storage, read_write> temperature_dst: array<f32>;
@group(0) @binding(5) var<storage, read> wall_inner_temperature_src: array<f32>;
@group(0) @binding(6) var<storage, read_write> wall_inner_temperature_dst: array<f32>;
@group(0) @binding(7) var<storage, read> wall_outer_temperature_src: array<f32>;
@group(0) @binding(8) var<storage, read_write> wall_outer_temperature_dst: array<f32>;

fn wall_conductivity_at(index: u32) -> f32 {
  return wall_thermal[index].x;
}

fn wall_inner_face_mask_at(index: u32) -> u32 {
  return u32(wall_thermal[index].y);
}

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

fn slab_rate(conductivity: f32) -> f32 {
  return clamp(
    max(0.0, conductivity) / max(params.reference_conductivity, 1e-6) *
      params.through_wall_rate * params.dt,
    0.0,
    0.24,
  );
}

fn surface_capacity() -> f32 {
  return max(params.surface_heat_capacity, params.wall_heat_capacity * 0.5);
}

fn face_bit(solid_x: i32, solid_y: i32, fluid_x: i32, fluid_y: i32) -> u32 {
  if (fluid_x < solid_x) { return 1u; }
  if (fluid_x > solid_x) { return 2u; }
  if (fluid_y < solid_y) { return 4u; }
  return 8u;
}

fn radiative_transfer(surface_temperature: f32, surroundings_temperature: f32) -> f32 {
  let surface_k = max(1.0, surface_temperature + 273.15);
  let surroundings_k = max(1.0, surroundings_temperature + 273.15);
  let surface_k2 = surface_k * surface_k;
  let surroundings_k2 = surroundings_k * surroundings_k;
  let flux = params.emissivity * params.stefan_boltzmann *
    (surface_k2 * surface_k2 - surroundings_k2 * surroundings_k2) *
    params.radiation_scale;
  return clamp(flux * params.dt, -0.18, 0.18);
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

  if (!current_is_solid) {
    var fluid_delta = 0.0;
    var face = 0u;
    loop {
      if (face >= 4u) { break; }
      var dx = 0i;
      var dy = 0i;
      if (face == 0u) { dx = -1i; }
      if (face == 1u) { dx = 1i; }
      if (face == 2u) { dy = -1i; }
      if (face == 3u) { dy = 1i; }
      let nx = x + dx;
      let ny = y + dy;
      if (in_grid(nx, ny)) {
        let neighbour = cell_index(nx, ny);
        if (solid[neighbour] != 0u) {
          let bit = face_bit(nx, ny, x, y);
          let is_inner = (wall_inner_face_mask_at(neighbour) & bit) != 0u;
          let surface_temperature = select(
            wall_outer_temperature_src[neighbour],
            wall_inner_temperature_src[neighbour],
            is_inner,
          );
          let conductive_transfer =
            (surface_temperature - temperature_src[i]) * interface_rate(wall_conductivity_at(neighbour));
          fluid_delta += conductive_transfer +
            radiative_transfer(surface_temperature, temperature_src[i]);
        }
      }
      face += 1u;
    }
    temperature_dst[i] = clamp(
      temperature_src[i] + fluid_delta,
      params.ambient_temperature,
      params.max_temperature,
    );
    wall_inner_temperature_dst[i] = wall_inner_temperature_src[i];
    wall_outer_temperature_dst[i] = wall_outer_temperature_src[i];
    return;
  }

  let inner_temperature = wall_inner_temperature_src[i];
  let outer_temperature = wall_outer_temperature_src[i];
  let conductivity = wall_conductivity_at(i);
  let capacity = surface_capacity();
  var inner_delta = (outer_temperature - inner_temperature) * slab_rate(conductivity);
  var outer_delta = -inner_delta;
  var has_outer_fluid = false;

  var face = 0u;
  loop {
    if (face >= 4u) { break; }
    var dx = 0i;
    var dy = 0i;
    if (face == 0u) { dx = -1i; }
    if (face == 1u) { dx = 1i; }
    if (face == 2u) { dy = -1i; }
    if (face == 3u) { dy = 1i; }
    let nx = x + dx;
    let ny = y + dy;
    if (in_grid(nx, ny)) {
      let neighbour = cell_index(nx, ny);
      let bit = face_bit(x, y, nx, ny);
      if (solid[neighbour] != 0u) {
        let response = interface_rate(harmonic_conductivity(
          conductivity,
          wall_conductivity_at(neighbour),
        )) / capacity;
        inner_delta += (wall_inner_temperature_src[neighbour] - inner_temperature) * response;
        outer_delta += (wall_outer_temperature_src[neighbour] - outer_temperature) * response;
      } else {
        let is_inner = (wall_inner_face_mask_at(i) & bit) != 0u;
        let surface_temperature = select(outer_temperature, inner_temperature, is_inner);
        let transfer = (surface_temperature - temperature_src[neighbour]) *
          interface_rate(conductivity) +
          radiative_transfer(surface_temperature, temperature_src[neighbour]);
        if (is_inner) {
          inner_delta -= transfer / capacity;
        } else {
          outer_delta -= transfer / capacity;
          has_outer_fluid = true;
        }
      }
    }
    face += 1u;
  }

  if (!has_outer_fluid) {
    outer_delta -= radiative_transfer(outer_temperature, params.ambient_temperature) / capacity;
  }

  temperature_dst[i] = temperature_src[i];
  wall_inner_temperature_dst[i] = clamp(
    inner_temperature + inner_delta,
    params.ambient_temperature,
    params.max_temperature,
  );
  wall_outer_temperature_dst[i] = clamp(
    outer_temperature + outer_delta,
    params.ambient_temperature,
    params.max_temperature,
  );
}
