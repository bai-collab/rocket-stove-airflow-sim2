// Physics v3 interface scaffold.
// rawStraw -> char + volatileGas
// No oxygen requirement here: pyrolysis is thermally driven in this teaching model.

export fn pyrolysis_factor(
  temperature: f32,
  start_temperature: f32,
  full_temperature: f32,
) -> f32 {
  let x = clamp(
    (temperature - start_temperature) / max(1.0, full_temperature - start_temperature),
    0.0,
    1.0,
  );
  return x * x * (3.0 - 2.0 * x);
}
