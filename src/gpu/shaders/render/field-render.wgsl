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
@group(0) @binding(5) var<storage, read> wall_material: array<u32>;
@group(0) @binding(6) var<storage, read> wall_thermal: array<vec2f>;
@group(0) @binding(7) var<storage, read> wall_inner_temperature: array<f32>;
@group(0) @binding(8) var<storage, read> wall_outer_temperature: array<f32>;

fn cell_index(px: vec2f) -> u32 {
  let gx = min(params.nx - 1u, u32(floor(clamp(px.x, 0.0, params.sim_width - 1e-3) / params.h)));
  let gy = min(params.ny - 1u, u32(floor(clamp(px.y, 0.0, params.sim_height - 1e-3) / params.h)));
  return gy * params.nx + gx;
}

fn grid_index(gx: i32, gy: i32) -> u32 {
  return u32(gy) * params.nx + u32(gx);
}

fn is_outer_face(gx: i32, gy: i32, inner_mask: u32, dx: i32, dy: i32, bit: u32) -> bool {
  if ((inner_mask & bit) != 0u) {
    return false;
  }
  let nx = gx + dx;
  let ny = gy + dy;
  if (nx < 0i || ny < 0i || nx >= i32(params.nx) || ny >= i32(params.ny)) {
    return true;
  }
  return solid[grid_index(nx, ny)] == 0u;
}

fn surface_edge_weights(uv: vec2f, gx: i32, gy: i32, inner_mask: u32) -> vec2f {
  let left_edge = 1.0 - smoothstep(0.04, 0.30, uv.x);
  let right_edge = smoothstep(0.70, 0.96, uv.x);
  let top_edge = 1.0 - smoothstep(0.04, 0.30, uv.y);
  let bottom_edge = smoothstep(0.70, 0.96, uv.y);
  var inner = 0.0;
  var outer = 0.0;

  if ((inner_mask & 1u) != 0u) { inner = max(inner, left_edge); }
  else if (is_outer_face(gx, gy, inner_mask, -1i, 0i, 1u)) { outer = max(outer, left_edge); }
  if ((inner_mask & 2u) != 0u) { inner = max(inner, right_edge); }
  else if (is_outer_face(gx, gy, inner_mask, 1i, 0i, 2u)) { outer = max(outer, right_edge); }
  if ((inner_mask & 4u) != 0u) { inner = max(inner, top_edge); }
  else if (is_outer_face(gx, gy, inner_mask, 0i, -1i, 4u)) { outer = max(outer, top_edge); }
  if ((inner_mask & 8u) != 0u) { inner = max(inner, bottom_edge); }
  else if (is_outer_face(gx, gy, inner_mask, 0i, 1i, 8u)) { outer = max(outer, bottom_edge); }
  return vec2f(inner, outer);
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
    var wall_color = vec3f(0.651, 0.373, 0.278);
    if (wall_material[i] == 1u) {
      wall_color = vec3f(0.894, 0.604, 0.420);
    }
    if (wall_material[i] == 3u) {
      wall_color = vec3f(0.435, 0.259, 0.216);
    }
    let inner_temperature = max(params.ambient_temperature, wall_inner_temperature[i]);
    let outer_temperature = max(params.ambient_temperature, wall_outer_temperature[i]);
    let inner_heat = clamp((inner_temperature - params.ambient_temperature) / 100.0, 0.0, 1.0);
    let outer_heat = clamp((outer_temperature - params.ambient_temperature) / 100.0, 0.0, 1.0);
    let body_heat = max(inner_heat, outer_heat) * 0.38;
    wall_color = mix(wall_color, vec3f(1.0, 0.220, 0.035), body_heat);

    let gx = i32(i % params.nx);
    let gy = i32(i / params.nx);
    let inner_mask = u32(wall_thermal[i].y);
    let edges = surface_edge_weights(fract(px / params.h), gx, gy, inner_mask);
    let outer_edge_alpha = edges.y * (0.10 + outer_heat * 0.84);
    let inner_edge_alpha = edges.x * (0.10 + inner_heat * 0.86);
    wall_color = mix(wall_color, vec3f(1.0, 0.76, 0.08), outer_edge_alpha);
    wall_color = mix(wall_color, vec3f(1.0, 0.16, 0.025), inner_edge_alpha);
    return vec4f(wall_color, 1.0);
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
