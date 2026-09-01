struct BoundaryParams {
  nx: u32,
  ny: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: BoundaryParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> reduced_stats: array<vec2f>;
@group(0) @binding(3) var<storage, read> velocity_src: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> velocity_dst: array<vec2f>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&velocity_src)) {
    return;
  }
  if (solid[i] != 0u) {
    velocity_dst[i] = vec2f(0.0);
    return;
  }

  var next = velocity_src[i];
  let totals = reduced_stats[0];
  let correction = select(0.0, totals.x / totals.y, totals.y > 0.0);
  let x = i % params.nx;
  let y = i / params.nx;

  if (x == 0u) {
    next.x += correction;
  }
  if (x + 1u == params.nx) {
    next.x -= correction;
  }
  if (y == 0u) {
    next.y += correction;
  }
  if (y + 1u == params.ny) {
    next.y -= correction;
  }

  velocity_dst[i] = next;
}
