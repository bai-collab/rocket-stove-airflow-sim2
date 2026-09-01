struct BuoyancyParams {
  dt: f32,
  ambient_temperature: f32,
  max_delta_temperature: f32,
  acceleration_scale: f32,
};

@group(0) @binding(0) var<uniform> params: BuoyancyParams;
@group(0) @binding(1) var<storage, read> temperature: array<f32>;
@group(0) @binding(2) var<storage, read> solid: array<u32>;
@group(0) @binding(3) var<storage, read> velocity_src: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> velocity_dst: array<vec2f>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&temperature)) {
    return;
  }

  let previous = velocity_src[i];
  if (solid[i] != 0u) {
    velocity_dst[i] = previous;
    return;
  }

  let delta_t = clamp(
    temperature[i] - params.ambient_temperature,
    0.0,
    params.max_delta_temperature
  );
  let acceleration_y = -9.81 * (1.0 / 298.15) * delta_t * params.acceleration_scale;
  velocity_dst[i] = vec2f(previous.x, previous.y + acceleration_y * params.dt);
}
