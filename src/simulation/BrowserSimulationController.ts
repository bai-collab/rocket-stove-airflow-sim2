import {
  AMBIENT_O2,
  AMBIENT_T,
  CpuRocketSimulation,
  H,
  NX,
  NY,
} from './CpuRocketSimulation.mjs';
import { GpuSimulationBackend } from '../gpu/GpuSimulationBackend';

export type BackendPreference = 'auto' | 'cpu' | 'gpu';
export type EffectiveBackend = 'cpu' | 'gpu';

export type BackendStatus = {
  requested: BackendPreference;
  effective: EffectiveBackend;
  label: string;
  detail: string;
  gpuAvailable: boolean;
  fallback: boolean;
};

type StatusListener = (status: BackendStatus) => void;

/**
 * Phase 3C browser coordinator.
 *
 * Ownership contract while fuel chemistry is still CPU-only:
 * - CPU owns geometry, finite-fuel transformation, cooling, secondary reaction,
 *   open-boundary scalar exchange, diagnostics and tracers.
 * - GPU owns one transport slice: buoyancy, velocity advection/projection and
 *   wall-safe scalar advection.
 * - One CPU->GPU upload and one GPU->CPU state handoff happen per physics tick.
 * - Rendering never performs its own GPU readback; it consumes the synchronized
 *   CPU arrays, so requestAnimationFrame remains independent from WebGPU I/O.
 */
export class BrowserSimulationController {
  readonly cpu: CpuRocketSimulation;

  private gpu: GpuSimulationBackend | null = null;
  private requested: BackendPreference = 'auto';
  private effective: EffectiveBackend = 'cpu';
  private detail = 'CPU reference backend';
  private fallback = false;
  private activeStep: Promise<void> | null = null;
  private listeners = new Set<StatusListener>();

  constructor() {
    this.cpu = new CpuRocketSimulation();
  }

  get status(): BackendStatus {
    const gpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean(navigator.gpu);
    return {
      requested: this.requested,
      effective: this.effective,
      label: this.effective === 'gpu' ? 'GPU · VGPU/WebGPU transport' : 'CPU · Physics v3 reference',
      detail: this.detail,
      gpuAvailable,
      fallback: this.fallback,
    };
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  async initialize(preference: BackendPreference = 'auto'): Promise<BackendStatus> {
    return this.setBackend(preference);
  }

  async setBackend(preference: BackendPreference): Promise<BackendStatus> {
    if (this.activeStep) await this.activeStep;
    this.requested = preference;
    this.fallback = false;

    if (preference === 'cpu') {
      this.effective = 'cpu';
      this.detail = 'CPU reference selected explicitly.';
      this.emitStatus();
      return this.status;
    }

    const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean(navigator.gpu);
    if (!hasWebGpu) {
      this.effective = 'cpu';
      this.fallback = true;
      this.detail = preference === 'gpu'
        ? 'This browser/device does not expose WebGPU; falling back to CPU.'
        : 'WebGPU unavailable; Auto selected the CPU fallback.';
      this.emitStatus();
      return this.status;
    }

    try {
      await this.ensureGpu();
      this.uploadCpuTransportState();
      this.effective = 'gpu';
      this.detail = preference === 'gpu'
        ? 'GPU transport selected. CPU still owns fuel chemistry and tracers.'
        : 'Auto selected GPU transport. CPU remains the Physics v3 reaction oracle.';
    } catch (error) {
      this.disposeGpu();
      this.effective = 'cpu';
      this.fallback = true;
      this.detail = `WebGPU initialization failed; CPU fallback active. ${this.describeError(error)}`;
    }

    this.emitStatus();
    return this.status;
  }

  async step(dt: number): Promise<void> {
    if (!(dt > 0) || !this.cpu.running) return;
    if (this.activeStep) return this.activeStep;

    const task = this.effective === 'gpu'
      ? this.stepGpuTransport(dt)
      : this.stepCpu(dt);
    this.activeStep = task.finally(() => {
      this.activeStep = null;
    });
    return this.activeStep;
  }

  loadPreset(id: string): boolean {
    return this.cpu.loadPreset(id);
  }

  clearScene(): void {
    this.cpu.clearScene();
  }

  setToolAt(tool: string, x: number, y: number): void {
    this.cpu.setToolAt(tool, x, y);
  }

  ignite(): void {
    this.cpu.ignite();
  }

  pause(): void {
    this.cpu.pause();
  }

  dispose(): void {
    this.disposeGpu();
    this.listeners.clear();
  }

  private async stepCpu(dt: number): Promise<void> {
    this.cpu.step(dt);
  }

  private async stepGpuTransport(dt: number): Promise<void> {
    const gpu = this.gpu;
    if (!gpu) {
      this.effective = 'cpu';
      this.fallback = true;
      this.detail = 'GPU backend was not initialized; CPU fallback active.';
      this.emitStatus();
      this.cpu.step(dt);
      return;
    }

    // Reproduce the CPU oracle order up to the transport boundary.
    this.cpu.time += dt;
    this.cpu.applyFuelTransformation(dt);

    try {
      this.uploadCpuTransportState();
      gpu.stepTransport(dt);

      const [velocity, scalars] = await Promise.all([
        gpu.readVelocity(),
        gpu.readScalarState(),
      ]);

      this.cpu.u.set(velocity.u);
      this.cpu.v.set(velocity.v);
      this.cpu.temperature.set(scalars.temperature);
      this.cpu.oxygen.set(scalars.oxygen);
      this.cpu.smoke.set(scalars.smoke);
      this.cpu.volatileGas.set(scalars.volatileGas);
      this.cpu.exhaustGas.set(scalars.exhaustGas);
      this.cpu.secondaryResidence.set(scalars.secondaryResidence);

      this.cpu.lastPressureResidual = this.estimateVelocityResidual();
      this.cpu.measureBoundaryFlux();

      // Continue with the CPU-owned half of the Physics v3 operator split.
      this.cpu.coolAndMix(dt);
      this.cpu.updateSecondaryResidence(dt);
      this.cpu.applySecondaryCombustion(dt);
      this.cpu.applyOpenBoundaryExchange(dt);
      this.cpu.updateTracers(dt);
    } catch (error) {
      // CPU is still at the post-fuel/pre-transport point. Complete the same
      // tick on CPU rather than dropping or double-applying fuel chemistry.
      this.completeCpuTransportFromCurrentState(dt);
      this.disposeGpu();
      this.effective = 'cpu';
      this.fallback = true;
      this.detail = `GPU runtime failed; the current tick completed on CPU and fallback is now active. ${this.describeError(error)}`;
      this.emitStatus();
    }
  }

  private completeCpuTransportFromCurrentState(dt: number): void {
    this.cpu.addBuoyancy(dt);

    this.cpu.uPrev.set(this.cpu.u);
    this.cpu.vPrev.set(this.cpu.v);
    this.cpu.advectField(this.cpu.u, this.cpu.uPrev, this.cpu.uPrev, this.cpu.vPrev, dt, 0, false);
    this.cpu.advectField(this.cpu.v, this.cpu.vPrev, this.cpu.uPrev, this.cpu.vPrev, dt, 0, false);
    this.cpu.projectVelocity();

    this.cpu.temperaturePrev.set(this.cpu.temperature);
    this.cpu.oxygenPrev.set(this.cpu.oxygen);
    this.cpu.smokePrev.set(this.cpu.smoke);
    this.cpu.volatilePrev.set(this.cpu.volatileGas);
    this.cpu.exhaustPrev.set(this.cpu.exhaustGas);
    this.cpu.secondaryResidencePrev.set(this.cpu.secondaryResidence);

    this.cpu.advectField(this.cpu.temperature, this.cpu.temperaturePrev, this.cpu.u, this.cpu.v, dt, AMBIENT_T, true);
    this.cpu.advectField(this.cpu.oxygen, this.cpu.oxygenPrev, this.cpu.u, this.cpu.v, dt, AMBIENT_O2, true);
    this.cpu.advectField(this.cpu.smoke, this.cpu.smokePrev, this.cpu.u, this.cpu.v, dt, 0, true);
    this.cpu.advectField(this.cpu.volatileGas, this.cpu.volatilePrev, this.cpu.u, this.cpu.v, dt, 0, true);
    this.cpu.advectField(this.cpu.exhaustGas, this.cpu.exhaustPrev, this.cpu.u, this.cpu.v, dt, 0, true);
    this.cpu.advectField(this.cpu.secondaryResidence, this.cpu.secondaryResidencePrev, this.cpu.u, this.cpu.v, dt, 0, true);

    this.cpu.coolAndMix(dt);
    this.cpu.updateSecondaryResidence(dt);
    this.cpu.applySecondaryCombustion(dt);
    this.cpu.applyOpenBoundaryExchange(dt);
    this.cpu.updateTracers(dt);
  }

  private uploadCpuTransportState(): void {
    const gpu = this.gpu;
    if (!gpu) throw new Error('GPU backend is not initialized');
    gpu.uploadAirflowState({
      temperature: this.cpu.temperature,
      solid: this.cpu.solid,
      u: this.cpu.u,
      v: this.cpu.v,
      oxygen: this.cpu.oxygen,
      smoke: this.cpu.smoke,
      volatileGas: this.cpu.volatileGas,
      exhaustGas: this.cpu.exhaustGas,
      secondaryResidence: this.cpu.secondaryResidence,
    });
  }

  private async ensureGpu(): Promise<void> {
    if (this.gpu) return;
    const gpu = new GpuSimulationBackend({ nx: NX, ny: NY, h: H });
    await gpu.initialize();
    this.gpu = gpu;
  }

  private disposeGpu(): void {
    this.gpu?.dispose();
    this.gpu = null;
  }

  private estimateVelocityResidual(): number {
    let residual = 0;
    let count = 0;
    const index = (x: number, y: number) => y * NX + x;
    const neighbour = (field: Float32Array, x: number, y: number, fallback: number) => {
      if (x < 0 || y < 0 || x >= NX || y >= NY) return fallback;
      const i = index(x, y);
      return this.cpu.solid[i] ? 0 : field[i];
    };

    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const i = index(x, y);
        if (this.cpu.solid[i]) continue;
        const u = this.cpu.u[i];
        const v = this.cpu.v[i];
        const uL = neighbour(this.cpu.u, x - 1, y, u);
        const uR = neighbour(this.cpu.u, x + 1, y, u);
        const vU = neighbour(this.cpu.v, x, y - 1, v);
        const vD = neighbour(this.cpu.v, x, y + 1, v);
        residual += Math.abs((uR - uL + vD - vU) / (2 * H));
        count += 1;
      }
    }
    return count ? residual / count : 0;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private emitStatus(): void {
    const current = this.status;
    for (const listener of this.listeners) listener(current);
  }
}
