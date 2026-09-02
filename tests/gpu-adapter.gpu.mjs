import assert from 'node:assert/strict';
import test from 'node:test';
import { init } from 'vgpu/node';

test('VGPU test command has a usable adapter', async () => {
  let gpu;
  try {
    gpu = await init({ adapter: 'auto' });
  } catch (error) {
    assert.fail(`VGPU tests require a usable Dawn/WebGPU adapter: ${error instanceof Error ? error.message : error}`);
  } finally {
    gpu?.dispose();
  }
});
