import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const roots = [
  'src/gpu/shaders/airflow',
  'src/gpu/shaders/scalar',
  'src/gpu/shaders/fuel',
];

const files = roots.flatMap((root) =>
  readdirSync(root)
    .filter((name) => name.endsWith('.wgsl'))
    .map((name) => join(root, name))
);

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
for (const file of files) {
  console.log(`\n[vgpu check] ${file}`);
  execFileSync(npx, ['vgpu', 'check', file], { stdio: 'inherit' });
}
