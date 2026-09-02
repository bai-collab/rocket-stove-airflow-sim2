struct TracerRenderParams {
  h: f32,
  nx: u32,
  ny: u32,
  tracer_count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  _pad3: u32,
};

@group(0) @binding(0) var<uniform> params: TracerRenderParams;
@group(0) @binding(1) var<storage, read> temperature: array<f32>;
@group(0) @binding(2) var<storage, read_write> tracers: array<vec4f>;

fn cell_index_from_point(point: vec2f) -> u32 {
  let width = f32(params.nx) * params.h;
  let height = f32(params.ny) * params.h;
  let x = min(params.nx - 1u, u32(floor(clamp(point.x, 0.0, width - 1e-3) / params.h)));
  let y = min(params.ny - 1u, u32(floor(clamp(point.y, 0.0, height - 1e-3) / params.h)));
  return y * params.nx + x;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.tracer_count) {
    return;
  }

  let current = tracers[i];
  tracers[i] = vec4f(current.xy, temperature[cell_index_from_point(current.xy)], current.w);
}
