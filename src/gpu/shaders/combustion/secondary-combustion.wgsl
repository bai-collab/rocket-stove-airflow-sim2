struct SecondaryCombustionParams {
  dt: f32,
  h: f32,
  oxidation_rate: f32,
  oxygen_use: f32,
  heat_gain: f32,
  max_temperature: f32,
  residence_scale: f32,
  _pad0: f32,
  nx: u32,
  ny: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: SecondaryCombustionParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> velocity: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> smoke: array<f32>;
@group(0) @binding(4) var<storage, read_write> oxygen: array<f32>;
@group(0) @binding(5) var<storage, read_write> exhaust_gas: array<f32>;
@group(0) @binding(6) var<storage, read_write> temperature: array<f32>;
@group(0) @binding(7) var<storage, read> residence: array<f32>;
@group(0) @binding(8) var<storage, read_write> reaction_stats: array<vec2f>;

fn smooth_unit(x: f32) -> f32 {
  let t = clamp(x, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn local_mixing(x: u32, y: u32, i: u32) -> f32 {
  var left = i;
  var right = i;
  var up = i;
  var down = i;
  if (x > 0u) { left = y * params.nx + (x - 1u); }
  if (x + 1u < params.nx) { right = y * params.nx + (x + 1u); }
  if (y > 0u) { up = (y - 1u) * params.nx + x; }
  if (y + 1u < params.ny) { down = (y + 1u) * params.nx + x; }

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
  if (i >= count) {
    return;
  }
  reaction_stats[i] = vec2f(0.0);
  if (solid[i] != 0u || smoke[i] <= 0.0) {
    return;
  }

  let x = i % params.nx;
  let y = i / params.nx;
  var s = smoke[i];
  var o2 = oxygen[i];
  var exhaust = exhaust_gas[i];
  var t = temperature[i];

  let temp_factor = smooth_unit((t - 260.0) / 300.0);
  let oxygen_factor = clamp((o2 - 0.08) / 0.65, 0.0, 1.0);
  let mixing = local_mixing(x, y, i);
  let residence_factor = clamp(residence[i] / params.residence_scale, 0.0, 1.0);
  let secondary = temp_factor * oxygen_factor * mixing * residence_factor;
  if (secondary <= 0.0) {
    return;
  }

  let potential = s * params.oxidation_rate * secondary * params.dt;
  let max_by_o2 = o2 / max(1e-6, params.oxygen_use);
  let oxidized = min(s, min(potential, max_by_o2));
  if (oxidized <= 0.0) {
    return;
  }

  s -= oxidized;
  o2 = clamp(o2 - oxidized * params.oxygen_use, 0.0, 1.0);
  exhaust += oxidized;
  t = clamp(t + oxidized * params.heat_gain, 25.0, params.max_temperature);

  smoke[i] = s;
  oxygen[i] = o2;
  exhaust_gas[i] = exhaust;
  temperature[i] = t;
  reaction_stats[i] = vec2f(oxidized, 0.0);
}
