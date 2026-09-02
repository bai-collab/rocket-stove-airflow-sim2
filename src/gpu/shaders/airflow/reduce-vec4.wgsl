struct ReductionParams {
  input_count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: ReductionParams;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let out_i = gid.x;
  let output_count = (params.input_count + 1u) / 2u;
  if (out_i >= output_count) {
    return;
  }

  let a = out_i * 2u;
  let b = a + 1u;
  var sum = src[a];
  if (b < params.input_count) {
    sum += src[b];
  }
  dst[out_i] = sum;
}
