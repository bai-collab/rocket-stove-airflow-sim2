struct ScalarMassParams {
  cell_count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: ScalarMassParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> scalar_src: array<f32>;
@group(0) @binding(3) var<storage, read> scalar_dst: array<f32>;
@group(0) @binding(4) var<storage, read_write> stats: array<vec4f>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.cell_count || solid[i] != 0u) {
    stats[i] = vec4f(0.0);
    return;
  }
  stats[i] = vec4f(max(0.0, scalar_src[i]), max(0.0, scalar_dst[i]), 0.0, 0.0);
}
