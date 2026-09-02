struct BoundaryScalarParams {
  dt: f32,
  h: f32,
  ambient_temperature: f32,
  ambient_oxygen: f32,
  nx: u32,
  ny: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: BoundaryScalarParams;
@group(0) @binding(1) var<storage, read> solid: array<u32>;
@group(0) @binding(2) var<storage, read> velocity: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> temperature: array<f32>;
@group(0) @binding(4) var<storage, read_write> oxygen: array<f32>;
@group(0) @binding(5) var<storage, read_write> smoke: array<f32>;
@group(0) @binding(6) var<storage, read_write> volatile_gas: array<f32>;
@group(0) @binding(7) var<storage, read_write> exhaust_gas: array<f32>;
@group(0) @binding(8) var<storage, read_write> outflow_stats: array<vec4f>;

fn freshen_k(normal_speed: f32) -> f32 {
  let rate = max(1.0, normal_speed / params.h);
  return clamp(rate * params.dt, 0.0, 1.0);
}

fn mix_toward(value: f32, target_value: f32, k: f32) -> f32 {
  return value + (target_value - value) * k;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let count = params.nx * params.ny;
  if (i >= count) {
    return;
  }

  outflow_stats[i] = vec4f(0.0);
  if (solid[i] != 0u) {
    return;
  }

  let x = i % params.nx;
  let y = i / params.nx;
  let vel = velocity[i];

  var t = temperature[i];
  var o2 = oxygen[i];
  var s = smoke[i];
  var vg = volatile_gas[i];
  var ex = exhaust_gas[i];
  var smoke_out = 0.0;
  var volatile_out = 0.0;
  var exhaust_out = 0.0;

  // Keep the same deterministic face order as CpuRocketSimulation:
  // top, bottom, left, right. Corners therefore apply two face operations.
  if (y == 0u) {
    if (vel.y > 0.0) {
      let k = freshen_k(vel.y);
      t = mix_toward(t, params.ambient_temperature, k);
      o2 = mix_toward(o2, params.ambient_oxygen, k);
      smoke_out += s * k;
      volatile_out += vg * k;
      exhaust_out += ex * k;
      s *= 1.0 - k;
      vg *= 1.0 - k;
      ex *= 1.0 - k;
    } else {
      let outward = -vel.y;
      let k = clamp(outward * params.dt / params.h, 0.0, 1.0);
      smoke_out += s * k;
      volatile_out += vg * k;
      exhaust_out += ex * k;
      s *= 1.0 - k;
      vg *= 1.0 - k;
      ex *= 1.0 - k;
    }
  }

  if (y + 1u == params.ny) {
    if (vel.y < 0.0) {
      let k = freshen_k(-vel.y);
      t = mix_toward(t, params.ambient_temperature, k);
      o2 = mix_toward(o2, params.ambient_oxygen, k);
      smoke_out += s * k;
      volatile_out += vg * k;
      exhaust_out += ex * k;
      s *= 1.0 - k;
      vg *= 1.0 - k;
      ex *= 1.0 - k;
    } else {
      let outward = vel.y;
      let k = clamp(outward * params.dt / params.h, 0.0, 1.0);
      smoke_out += s * k;
      volatile_out += vg * k;
      exhaust_out += ex * k;
      s *= 1.0 - k;
      vg *= 1.0 - k;
      ex *= 1.0 - k;
    }
  }

  if (x == 0u) {
    if (vel.x > 0.0) {
      let k = freshen_k(vel.x);
      t = mix_toward(t, params.ambient_temperature, k);
      o2 = mix_toward(o2, params.ambient_oxygen, k);
      smoke_out += s * k;
      volatile_out += vg * k;
      exhaust_out += ex * k;
      s *= 1.0 - k;
      vg *= 1.0 - k;
      ex *= 1.0 - k;
    } else {
      let outward = -vel.x;
      let k = clamp(outward * params.dt / params.h, 0.0, 1.0);
      smoke_out += s * k;
      volatile_out += vg * k;
      exhaust_out += ex * k;
      s *= 1.0 - k;
      vg *= 1.0 - k;
      ex *= 1.0 - k;
    }
  }

  if (x + 1u == params.nx) {
    if (vel.x < 0.0) {
      let k = freshen_k(-vel.x);
      t = mix_toward(t, params.ambient_temperature, k);
      o2 = mix_toward(o2, params.ambient_oxygen, k);
      smoke_out += s * k;
      volatile_out += vg * k;
      exhaust_out += ex * k;
      s *= 1.0 - k;
      vg *= 1.0 - k;
      ex *= 1.0 - k;
    } else {
      let outward = vel.x;
      let k = clamp(outward * params.dt / params.h, 0.0, 1.0);
      smoke_out += s * k;
      volatile_out += vg * k;
      exhaust_out += ex * k;
      s *= 1.0 - k;
      vg *= 1.0 - k;
      ex *= 1.0 - k;
    }
  }

  temperature[i] = t;
  oxygen[i] = o2;
  smoke[i] = s;
  volatile_gas[i] = vg;
  exhaust_gas[i] = ex;
  outflow_stats[i] = vec4f(smoke_out, volatile_out, exhaust_out, 0.0);
}
