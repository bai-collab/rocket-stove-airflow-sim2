import { defineConfig } from 'vite';
import { wgslVitePlugin } from '@vgpu/wgsl/loader-vite';

export default defineConfig(({ mode }) => ({
  base: '/rocket-stove-airflow-sim2/',
  plugins: [wgslVitePlugin({ minify: mode === 'production' })],
  build: {
    rollupOptions: {
      // teacher.html only works with the local tutor service; on Pages it
      // explains that instead of failing silently.
      input: { main: 'index.html', teacher: 'teacher.html' },
    },
  },
}));
