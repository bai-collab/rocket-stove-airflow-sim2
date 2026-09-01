import { pyrolysis_factor } from "./pyrolysis.wgsl";
import { char_oxidation_factor } from "./char-oxidation.wgsl";

@group(0) @binding(0) var<storage, read_write> check_output: array<f32>;

@compute @workgroup_size(1)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x > 0u) {
    return;
  }
  check_output[0] = pyrolysis_factor(420.0, 140.0, 420.0);
  check_output[1] = char_oxidation_factor(620.0, 1.0);
}
