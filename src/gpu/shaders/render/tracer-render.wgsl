struct TracerRenderParams {
  sim_width: f32,
  sim_height: f32,
  h: f32,
  radius: f32,
  nx: u32,
  ny: u32,
  tracer_count: u32,
  _pad0: u32,
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) color: vec3f,
};

@group(0) @binding(0) var<uniform> params: TracerRenderParams;
@group(0) @binding(1) var<storage, read> tracers: array<vec2f>;
@group(0) @binding(2) var<storage, read> temperature: array<f32>;

fn quad_corner(vertex_index: u32) -> vec2f {
  switch vertex_index {
    case 0u: { return vec2f(-1.0, -1.0); }
    case 1u: { return vec2f( 1.0, -1.0); }
    case 2u: { return vec2f(-1.0,  1.0); }
    case 3u: { return vec2f(-1.0,  1.0); }
    case 4u: { return vec2f( 1.0, -1.0); }
    default: { return vec2f( 1.0,  1.0); }
  }
}

fn temperature_at(p: vec2f) -> f32 {
  let gx = min(params.nx - 1u, u32(floor(clamp(p.x, 0.0, params.sim_width - 1e-3) / params.h)));
  let gy = min(params.ny - 1u, u32(floor(clamp(p.y, 0.0, params.sim_height - 1e-3) / params.h)));
  return temperature[gy * params.nx + gx];
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32,
) -> VertexOut {
  var out: VertexOut;
  let p = tracers[min(instance_index, params.tracer_count - 1u)];
  let local = quad_corner(vertex_index);
  let pixel = p + local * params.radius;
  let ndc = vec2f(
    pixel.x / params.sim_width * 2.0 - 1.0,
    1.0 - pixel.y / params.sim_height * 2.0
  );
  out.position = vec4f(ndc, 0.0, 1.0);
  out.local = local;
  out.color = select(
    vec3f(0.145, 0.388, 0.922),
    vec3f(0.976, 0.451, 0.086),
    temperature_at(p) > 100.0
  );
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  if (dot(in.local, in.local) > 1.0) {
    discard;
  }
  return vec4f(in.color, 1.0);
}
