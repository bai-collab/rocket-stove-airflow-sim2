struct ScalarNormalizeParams {
  source_epsilon: f32,
  cell_count: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: ScalarNormalizeParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read_write> scalar: array<f32>;
@group(0) @binding(3) var<storage, read> totals: array<vec4f>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.cell_count || solid[i] != 0u) {
    return;
  }

  let source_total = max(0.0, totals[0].x);
  let destination_total = max(0.0, totals[0].y);
  if (source_total <= params.source_epsilon) {
    scalar[i] = 0.0;
  } else if (destination_total > params.source_epsilon) {
    scalar[i] = max(0.0, scalar[i]) * source_total / destination_total;
  }
}
