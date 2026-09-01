struct BoundaryParams {
  nx: u32,
  ny: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: BoundaryParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> velocity: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> stats: array<vec2f>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&stats)) {
    return;
  }
  if (solid[i] != 0u) {
    stats[i] = vec2f(0.0);
    return;
  }

  let x = i % params.nx;
  let y = i / params.nx;
  var net_outward = 0.0;
  var face_count = 0.0;

  if (x == 0u) {
    net_outward += -velocity[i].x;
    face_count += 1.0;
  }
  if (x + 1u == params.nx) {
    net_outward += velocity[i].x;
    face_count += 1.0;
  }
  if (y == 0u) {
    net_outward += -velocity[i].y;
    face_count += 1.0;
  }
  if (y + 1u == params.ny) {
    net_outward += velocity[i].y;
    face_count += 1.0;
  }

  stats[i] = vec2f(net_outward, face_count);
}
