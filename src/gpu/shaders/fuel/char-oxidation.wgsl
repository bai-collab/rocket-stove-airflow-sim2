// Physics v3 interface scaffold.
// IMPORTANT: char oxidation exposes ash from a separate mineral reservoir.
// Carbon is not converted into mineral ash.

export fn char_oxidation_factor(temperature: f32, oxygen: f32) -> f32 {
  let heat = clamp((temperature - 260.0) / 360.0, 0.0, 1.0);
  let o2 = clamp((oxygen - 0.06) / 0.70, 0.0, 1.0);
  return heat * o2;
}
