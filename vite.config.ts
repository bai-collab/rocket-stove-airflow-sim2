import { defineConfig } from 'vite';
import { wgslVitePlugin } from '@vgpu/wgsl/loader-vite';

export default defineConfig(({ mode }) => ({
  base: '/rocket-stove-airflow-sim2/',
  plugins: [wgslVitePlugin({ minify: mode === 'production' })],
}));
