import { defineConfig } from 'vite';
import { wgslVitePlugin } from '@vgpu/wgsl/loader-vite';

export default defineConfig(({ mode }) => ({
  plugins: [wgslVitePlugin({ minify: mode === 'production' })],
}));
