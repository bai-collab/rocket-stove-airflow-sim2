import {
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
 * Phase 4 browser coordinator.
 *
 * GPU mode owns Physics v3 fuel transformation, airflow, scalar transport,
 * cooling/residence, secondary combustion and open-boundary scalar exchange.
 * CPU remains the synchronized presentation/oracle mirror for diagnostics,
 * Canvas2D rendering and tracer particles until those are migrated later.
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
  private gpuStateDirty = true;

  constructor() {
    this.cpu = new CpuRocketSimulation();
  }

  get status(): BackendStatus {
    const gpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean(navigator.gpu);
    return {
      requested: this.requested,
      effective: this.effective,
      label: this.effective === 'gpu' ? 'GPU · VGPU Physics v3' : 'CPU · Physics v3 reference',
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
      this.uploadCpuFullState();
      this.gpuStateDirty = false;
      this.effective = 'gpu';
      this.detail = preference === 'gpu'
        ? 'GPU Physics v3 selected. Fuel reactions and transport run on VGPU/WebGPU; CPU mirrors results for rendering and tracers.'
        : 'Auto selected GPU Physics v3. CPU remains the synchronized reference/render mirror.';
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
      ? this.stepGpuPhysics(dt)
      : this.stepCpu(dt);
    this.activeStep = task.finally(() => {
      this.activeStep = null;
    });
    return this.activeStep;
  }

  loadPreset(id: string): boolean {
    const loaded = this.cpu.loadPreset(id);
    if (loaded) this.gpuStateDirty = true;
    return loaded;
  }

  clearScene(): void {
    this.cpu.clearScene();
    this.gpuStateDirty = true;
  }

  setToolAt(tool: string, x: number, y: number): void {
    this.cpu.setToolAt(tool, x, y);
    this.gpuStateDirty = true;
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

  private async stepGpuPhysics(dt: number): Promise<void> {
    const gpu = this.gpu;
    if (!gpu) {
      this.fallbackToCpu('GPU backend was not initialized; CPU fallback active.');
      this.cpu.step(dt);
      return;
    }

    const previousTime = this.cpu.time;
    const previousIgnitionRemaining = this.cpu.ignitionRemaining;

    try {
      if (this.gpuStateDirty) {
        this.uploadCpuFullState();
        this.gpuStateDirty = false;
      }

      this.cpu.time += dt;
      const ignitionActive = this.cpu.ignitionRemaining > 0;
      if (ignitionActive) {
        this.cpu.ignitionRemaining = Math.max(0, this.cpu.ignitionRemaining - dt);
      }

      gpu.stepPhysics(dt, { ignitionActive });

      const [velocity, scalars, fuel, outflow, secondaryReacted] = await Promise.all([
        gpu.readVelocity(),
        gpu.readScalarState(),
        gpu.readFuelState(),
        gpu.readScalarOutflowTotal(),
        gpu.readSecondaryReactionTotal(),
      ]);

      this.cpu.u.set(velocity.u);
      this.cpu.v.set(velocity.v);
      this.cpu.temperature.set(scalars.temperature);
      this.cpu.oxygen.set(scalars.oxygen);
      this.cpu.smoke.set(scalars.smoke);
      this.cpu.volatileGas.set(scalars.volatileGas);
      this.cpu.exhaustGas.set(scalars.exhaustGas);
      this.cpu.secondaryResidence.set(scalars.secondaryResidence);
      this.cpu.rawStraw.set(fuel.rawStraw);
      this.cpu.char.set(fuel.char);
      this.cpu.mineralMatter.set(fuel.mineralMatter);
      this.cpu.ash.set(fuel.ash);

      this.updateCpuReactionDiagnostics(outflow, secondaryReacted, dt);
      this.cpu.lastPressureResidual = this.estimateVelocityResidual();
      this.cpu.measureBoundaryFlux();
      this.cpu.updateTracers(dt);
    } catch (error) {
      // CPU arrays still represent the last completed tick because all GPU
      // readbacks are applied only after Promise.all succeeds. Restore the two
      // scalar clock values and execute the same tick once on CPU.
      this.cpu.time = previousTime;
      this.cpu.ignitionRemaining = previousIgnitionRemaining;
      this.disposeGpu();
      this.fallbackToCpu(
        `GPU runtime failed; the current tick was recomputed once on CPU. ${this.describeError(error)}`
      );
      this.cpu.step(dt);
    }
  }

  private updateCpuReactionDiagnostics(
    outflow: { smokeOut: number; volatileOut: number },
    secondaryReacted: number,
    dt: number,
  ): void {
    const raw = this.cpu.sum(this.cpu.rawStraw);
    const charMass = this.cpu.sum(this.cpu.char);
    const pyrolyzed = Math.max(0, this.cpu.initialOrganic - raw);

    this.cpu.pyrolyzedTotal = pyrolyzed;
    this.cpu.charGeneratedTotal = pyrolyzed * 0.34;
    this.cpu.volatileGeneratedTotal = pyrolyzed * 0.66;
    this.cpu.charBurnedTotal = Math.max(0, this.cpu.charGeneratedTotal - charMass);
    this.cpu.smokeOutTotal += Math.max(0, outflow.smokeOut);
    this.cpu.volatileOutTotal += Math.max(0, outflow.volatileOut);
    this.cpu.smokeOxidizedTotal += Math.max(0, secondaryReacted);
    this.cpu.lastSecondaryRate = Math.max(0, secondaryReacted) / Math.max(dt, 1e-6);
  }

  private uploadCpuFullState(): void {
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
      fuelMask: this.cpu.fuelMask,
      rawStraw: this.cpu.rawStraw,
      char: this.cpu.char,
      mineralMatter: this.cpu.mineralMatter,
      ash: this.cpu.ash,
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
    this.gpuStateDirty = true;
  }

  private fallbackToCpu(detail: string): void {
    this.effective = 'cpu';
    this.fallback = true;
    this.detail = detail;
    this.emitStatus();
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
