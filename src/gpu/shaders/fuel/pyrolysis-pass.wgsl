struct PyrolysisParams {
  dt: f32,
  ignition_active: f32,
  pyrolysis_start_temperature: f32,
  pyrolysis_full_temperature: f32,
  pyrolysis_rate: f32,
  char_yield: f32,
  volatile_yield: f32,
  ignition_heat_rate: f32,
  ambient_temperature: f32,
  max_temperature: f32,
  cell_count: u32,
  _pad0: u32,
};

@group(0) @binding(0) var<uniform> params: PyrolysisParams;
@group(0) @binding(1) var<storage, read> fuel_mask: array<u32>;
@group(0) @binding(2) var<storage, read_write> raw_straw: array<f32>;
@group(0) @binding(3) var<storage, read_write> char_mass: array<f32>;
@group(0) @binding(4) var<storage, read_write> volatile_gas: array<f32>;
@group(0) @binding(5) var<storage, read_write> temperature: array<f32>;

fn smooth_unit(x: f32) -> f32 {
  let t = clamp(x, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.cell_count || fuel_mask[i] == 0u) {
    return;
  }

  var t = temperature[i];
  let active_fuel = raw_straw[i] + char_mass[i];
  if (params.ignition_active > 0.5 && active_fuel > 1e-8) {
    t = clamp(
      t + params.ignition_heat_rate * params.dt,
      params.ambient_temperature,
      params.max_temperature,
    );
  }

  let pyro_factor = smooth_unit(
    (t - params.pyrolysis_start_temperature) /
    max(1.0, params.pyrolysis_full_temperature - params.pyrolysis_start_temperature)
  );

  let raw = raw_straw[i];
  if (pyro_factor > 0.0 && raw > 0.0) {
    let converted = min(raw, raw * params.pyrolysis_rate * pyro_factor * params.dt);
    raw_straw[i] = raw - converted;
    char_mass[i] += converted * params.char_yield;
    volatile_gas[i] += converted * params.volatile_yield;
  }

  temperature[i] = t;
}
