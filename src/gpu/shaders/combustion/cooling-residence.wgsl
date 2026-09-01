struct CoolingResidenceParams {
  dt: f32,
  ambient_temperature: f32,
  max_temperature: f32,
  cooling_rate: f32,
  residence_max: f32,
  residence_decay_rate: f32,
  reactive_threshold: f32,
  moving_threshold: f32,
  hot_threshold: f32,
  _pad0: f32,
  nx: u32,
  ny: u32,
};

@group(0) @binding(0) var<uniform> params: CoolingResidenceParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> velocity: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> temperature: array<f32>;
@group(0) @binding(4) var<storage, read_write> oxygen: array<f32>;
@group(0) @binding(5) var<storage, read_write> smoke: array<f32>;
@group(0) @binding(6) var<storage, read_write> volatile_gas: array<f32>;
@group(0) @binding(7) var<storage, read_write> residence: array<f32>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let count = params.nx * params.ny;
  if (i >= count || solid[i] != 0u) {
    return;
  }

  var t = temperature[i];
  var o2 = oxygen[i];
  var s = smoke[i];
  var vg = volatile_gas[i];
  var r = residence[i];

  t = clamp(
    t + (params.ambient_temperature - t) * params.cooling_rate * params.dt,
    params.ambient_temperature,
    params.max_temperature,
  );
  o2 = clamp(o2, 0.0, 1.0);
  s = max(0.0, s);
  vg = max(0.0, vg);

  let reactive = s + vg;
  let hot = t >= params.hot_threshold;
  let moving = length(velocity[i]) >= params.moving_threshold;
  if (reactive > params.reactive_threshold && hot && moving) {
    r = clamp(r + params.dt, 0.0, params.residence_max);
  } else {
    r = max(0.0, r - params.dt * params.residence_decay_rate);
  }

  temperature[i] = t;
  oxygen[i] = o2;
  smoke[i] = s;
  volatile_gas[i] = vg;
  residence[i] = r;
}
