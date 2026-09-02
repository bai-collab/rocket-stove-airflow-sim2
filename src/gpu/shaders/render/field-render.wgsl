struct RenderParams {
  h: f32,
  sim_width: f32,
  sim_height: f32,
  ambient_temperature: f32,
  nx: u32,
  ny: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: RenderParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> velocity: array<vec2f>;
@group(0) @binding(3) var<storage, read> render_state: array<vec4f>;
@group(0) @binding(4) var<storage, read> ash: array<f32>;

fn cell_index(px: vec2f) -> u32 {
  let gx = min(params.nx - 1u, u32(floor(clamp(px.x, 0.0, params.sim_width - 1e-3) / params.h)));
  let gy = min(params.ny - 1u, u32(floor(clamp(px.y, 0.0, params.sim_height - 1e-3) / params.h)));
  return gy * params.nx + gx;
}

fn distance_to_segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let denom = max(dot(ab, ab), 1e-6);
  let t = clamp(dot(p - a, ab) / denom, 0.0, 1.0);
  return length(p - (a + ab * t));
}

fn velocity_overlay(px: vec2f) -> f32 {
  let macro_size = params.h * 4.0;
  let block = floor(px / macro_size) * macro_size;
  let center = block + vec2f(params.h * 2.5);
  if (center.x >= params.sim_width || center.y >= params.sim_height) {
    return 0.0;
  }
  let i = cell_index(center);
  if (solid[i] != 0u) {
    return 0.0;
  }
  let vel = velocity[i];
  let speed = length(vel);
  if (speed < 2.0) {
    return 0.0;
  }
  let extent = min(12.0, 2.0 + speed * 0.18);
  let tip = center + vel / speed * extent;
  let d = distance_to_segment(px, center, tip);
  return 1.0 - smoothstep(0.45, 1.15, d);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = vec2f(uv.x * params.sim_width, uv.y * params.sim_height);
  let i = cell_index(px);

  if (solid[i] != 0u) {
    return vec4f(0.651, 0.373, 0.278, 1.0);
  }

  var color = vec3f(0.973, 0.980, 0.988);
  let state = render_state[i];
  let t = state.x;
  if (t > params.ambient_temperature + 8.0) {
    let heat = clamp((t - params.ambient_temperature) / 450.0, 0.0, 1.0);
    let alpha = 0.04 + heat * 0.30;
    color = mix(color, vec3f(0.961, 0.439, 0.149), alpha);
  }

  let smoke_alpha = min(0.62, max(0.0, state.y) * 3.4);
  color = mix(color, vec3f(0.098, 0.110, 0.129), smoke_alpha);

  {
    let raw = max(0.0, state.z);
    let c = max(0.0, state.w);
    let a = max(0.0, ash[i]);
    let total = raw + c + a;
    if (total > 1e-7) {
      let char_ratio = c / total;
      let ash_ratio = a / total;
      var fuel_color = mix(vec3f(0.91, 0.745, 0.259), vec3f(0.08, 0.075, 0.07), char_ratio);
      fuel_color = mix(fuel_color, vec3f(0.64, 0.635, 0.60), ash_ratio);
      color = fuel_color;
    }
  }

  let vector_alpha = velocity_overlay(px) * 0.42;
  color = mix(color, vec3f(0.20, 0.255, 0.33), vector_alpha);
  return vec4f(color, 1.0);
}
