import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const computeRoots = [
  'src/gpu/shaders/airflow',
  'src/gpu/shaders/scalar',
];

const files = computeRoots.flatMap((root) =>
  readdirSync(root)
    .filter((name) => name.endsWith('.wgsl'))
    .map((name) => join(root, name))
);

// Fuel files are currently VGPU WGSL helper modules (export fn, no entry point).
// Validate them through one runnable module that imports both helpers so the
// resolver still parses and type-checks their source.
files.push('src/gpu/shaders/fuel/scaffold-check.wgsl');

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
for (const file of files) {
  console.log(`\n[vgpu check] ${file}`);
  execFileSync(npx, ['vgpu', 'check', file], { stdio: 'inherit' });
}
