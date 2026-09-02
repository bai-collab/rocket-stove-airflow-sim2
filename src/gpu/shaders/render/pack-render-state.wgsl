struct RenderStatePackParams {
  cell_count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: RenderStatePackParams;
@group(0) @binding(1) var<storage, read> temperature: array<f32>;
@group(0) @binding(2) var<storage, read> smoke: array<f32>;
@group(0) @binding(3) var<storage, read> raw_straw: array<f32>;
@group(0) @binding(4) var<storage, read> char_mass: array<f32>;
@group(0) @binding(5) var<storage, read_write> render_state: array<vec4f>;
@group(0) @binding(6) var<storage, read> solid: array<u32>;
@group(0) @binding(7) var<storage, read> wall_inner_temperature: array<f32>;
@group(0) @binding(8) var<storage, read> wall_outer_temperature: array<f32>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.cell_count) {
    return;
  }
  let wall_temperature = (wall_inner_temperature[i] + wall_outer_temperature[i]) * 0.5;
  let display_temperature = select(temperature[i], wall_temperature, solid[i] != 0u);
  render_state[i] = vec4f(display_temperature, smoke[i], raw_straw[i], char_mass[i]);
}
