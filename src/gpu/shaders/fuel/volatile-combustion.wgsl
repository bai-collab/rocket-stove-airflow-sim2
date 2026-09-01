struct VolatileCombustionParams {
  dt: f32,
  h: f32,
  burn_start_temperature: f32,
  burn_full_temperature: f32,
  burn_rate: f32,
  oxygen_use: f32,
  heat_gain: f32,
  clean_smoke_yield: f32,
  dirty_smoke_yield: f32,
  max_temperature: f32,
  nx: u32,
  ny: u32,
};

@group(0) @binding(0) var<uniform> params: VolatileCombustionParams;
@group(0) @binding(1) var<storage, read> fuel_mask: array<u32>;
@group(0) @binding(2) var<storage, read> velocity: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> volatile_gas: array<f32>;
@group(0) @binding(4) var<storage, read_write> oxygen: array<f32>;
@group(0) @binding(5) var<storage, read_write> temperature: array<f32>;
@group(0) @binding(6) var<storage, read_write> exhaust_gas: array<f32>;
@group(0) @binding(7) var<storage, read_write> smoke: array<f32>;

fn smooth_unit(x: f32) -> f32 {
  let t = clamp(x, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn velocity_at(x: u32, y: u32) -> vec2f {
  return velocity[y * params.nx + x];
}

fn local_mixing(x: u32, y: u32, i: u32) -> f32 {
  let left = select(i, y * params.nx + (x - 1u), x > 0u);
  let right = select(i, y * params.nx + (x + 1u), x + 1u < params.nx);
  let up = select(i, (y - 1u) * params.nx + x, y > 0u);
  let down = select(i, (y + 1u) * params.nx + x, y + 1u < params.ny);
  let dvdx = (velocity[right].y - velocity[left].y) / (2.0 * params.h);
  let dudy = (velocity[down].x - velocity[up].x) / (2.0 * params.h);
  let vorticity = abs(dvdx - dudy) * params.h;
  let speed = length(velocity[i]);
  return clamp(0.16 + speed / 80.0 + vorticity / 24.0, 0.16, 1.0);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let count = params.nx * params.ny;
  if (i >= count || fuel_mask[i] == 0u || volatile_gas[i] <= 0.0) {
    return;
  }

  let x = i % params.nx;
  let y = i / params.nx;
  var vg = volatile_gas[i];
  var o2 = oxygen[i];
  var t = temperature[i];
  var exhaust = exhaust_gas[i];
  var s = smoke[i];

  let burn_temp = smooth_unit(
    (t - params.burn_start_temperature) /
    max(1.0, params.burn_full_temperature - params.burn_start_temperature)
  );
  let o2_factor = clamp((o2 - 0.04) / 0.72, 0.0, 1.0);
  let mixing = local_mixing(x, y, i);
  let completeness = clamp(burn_temp * o2_factor * (0.25 + 0.75 * mixing), 0.0, 1.0);
  let burn_potential = vg * params.burn_rate * completeness * params.dt;
  let max_by_o2 = o2 / max(1e-6, params.oxygen_use);
  let burned = min(vg, min(burn_potential, max_by_o2));

  if (burned > 0.0) {
    vg -= burned;
    o2 = clamp(o2 - burned * params.oxygen_use, 0.0, 1.0);
    exhaust += burned;
    t = clamp(t + burned * params.heat_gain, 25.0, params.max_temperature);
  }

  let hot_enough_to_smoke = smooth_unit((t - 110.0) / 180.0);
  let poor_combustion = 1.0 - completeness;
  let smoke_yield = params.clean_smoke_yield +
    params.dirty_smoke_yield * pow(poor_combustion, 1.35);
  let smoke_source = min(vg, vg * smoke_yield * hot_enough_to_smoke * params.dt);
  if (smoke_source > 0.0) {
    vg -= smoke_source;
    s += smoke_source;
  }

  volatile_gas[i] = vg;
  oxygen[i] = o2;
  temperature[i] = t;
  exhaust_gas[i] = exhaust;
  smoke[i] = s;
}
