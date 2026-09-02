struct CharOxidationParams {
  dt: f32,
  oxidation_rate: f32,
  oxygen_use: f32,
  heat_gain: f32,
  ash_exposure_per_char: f32,
  max_temperature: f32,
  ambient_temperature: f32,
  cell_count: u32,
  _pad0: u32,
};

@group(0) @binding(0) var<uniform> params: CharOxidationParams;
@group(0) @binding(1) var<storage, read> fuel_mask: array<u32>;
@group(0) @binding(2) var<storage, read_write> char_mass: array<f32>;
@group(0) @binding(3) var<storage, read_write> oxygen: array<f32>;
@group(0) @binding(4) var<storage, read_write> temperature: array<f32>;
@group(0) @binding(5) var<storage, read_write> exhaust_gas: array<f32>;
@group(0) @binding(6) var<storage, read_write> mineral_matter: array<f32>;
@group(0) @binding(7) var<storage, read_write> ash: array<f32>;

fn smooth_unit(x: f32) -> f32 {
  let t = clamp(x, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.cell_count || fuel_mask[i] == 0u || char_mass[i] <= 0.0) {
    return;
  }

  var char_value = char_mass[i];
  var o2 = oxygen[i];
  var t = temperature[i];
  var exhaust = exhaust_gas[i];
  var mineral = mineral_matter[i];
  var ash_value = ash[i];

  let char_temp = smooth_unit((t - 260.0) / 360.0);
  let o2_factor = clamp((o2 - 0.06) / 0.70, 0.0, 1.0);
  let potential = char_value * params.oxidation_rate * char_temp * o2_factor * params.dt;
  let max_by_o2 = o2 / max(1e-6, params.oxygen_use);
  let oxidized = min(char_value, min(potential, max_by_o2));

  if (oxidized > 0.0) {
    char_value -= oxidized;
    o2 = clamp(o2 - oxidized * params.oxygen_use, 0.0, 1.0);
    exhaust += oxidized;
    t = clamp(t + oxidized * params.heat_gain, params.ambient_temperature, params.max_temperature);
    let exposed = min(mineral, oxidized * params.ash_exposure_per_char);
    mineral -= exposed;
    ash_value += exposed;
  }

  char_mass[i] = char_value;
  oxygen[i] = o2;
  temperature[i] = t;
  exhaust_gas[i] = exhaust;
  mineral_matter[i] = mineral;
  ash[i] = ash_value;
}
