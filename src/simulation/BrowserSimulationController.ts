import {
  CpuRocketSimulation,
  H,
  NX,
  NY,
  SIM_HEIGHT,
  SIM_WIDTH,
} from './CpuRocketSimulation.mjs';
import { DEFAULT_FUEL_PARAMS } from '../physics/fuel-model.mjs';
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

type CpuCheckpoint = {
  time: number;
  ignitionRemaining: number;
  pyrolyzedTotal: number;
  charGeneratedTotal: number;
  charBurnedTotal: number;
  volatileGeneratedTotal: number;
  volatileBurnedTotal: number;
  smokeGeneratedTotal: number;
  smokeOxidizedTotal: number;
  exhaustTotal: number;
  smokeOutTotal: number;
  volatileOutTotal: number;
  exhaustOutTotal: number;
  lastSecondaryRate: number;
  lastPressureResidual: number;
  lastInflow: number;
  lastOutflow: number;
};

const GPU_CHECKPOINT_INTERVAL_TICKS = 6;

/**
 * Phase 5 browser coordinator.
 *
 * GPU mode owns Physics v3, tracer particles and field presentation. CPU arrays
 * are a low-frequency checkpoint/oracle mirror used by diagnostics, explicit
 * CPU switching and deterministic fallback replay after a GPU failure.
 */
export class BrowserSimulationController {
  readonly cpu: CpuRocketSimulation;

  private gpu: GpuSimulationBackend | null = null;
  private renderCanvas: HTMLCanvasElement | null = null;
  private requested: BackendPreference = 'auto';
  private effective: EffectiveBackend = 'cpu';
  private detail = 'CPU reference backend';
  private fallback = false;
  private activeStep: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private listeners = new Set<StatusListener>();
  private gpuStateDirty = true;
  private gpuTracersDirty = true;
  private gpuTicksSinceCheckpoint = 0;
  private checkpoint: CpuCheckpoint | null = null;

  constructor() {
    this.cpu = new CpuRocketSimulation();
    this.captureCheckpoint();
  }

  get status(): BackendStatus {
    const gpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean(navigator.gpu);
    return {
      requested: this.requested,
      effective: this.effective,
      label: this.effective === 'gpu' ? 'GPU · Physics + Tracers + Render' : 'CPU · Physics v3 reference',
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

  attachGpuCanvas(canvas: HTMLCanvasElement): void {
    this.renderCanvas = canvas;
    if (this.gpu) this.gpu.attachRenderCanvas(canvas);
  }

  async initialize(preference: BackendPreference = 'auto'): Promise<BackendStatus> {
    return this.setBackend(preference);
  }

  async setBackend(preference: BackendPreference): Promise<BackendStatus> {
    return this.enqueueMutation(() => this.setBackendInternal(preference));
  }

  private async setBackendInternal(preference: BackendPreference): Promise<BackendStatus> {
    await this.waitForIdle();
    this.requested = preference;
    this.fallback = false;

    // A backend re-selection must start from the newest GPU checkpoint. Without
    // this readback, choosing Auto/GPU again could silently rewind the last few
    // device-local ticks to the older CPU mirror.
    if (this.effective === 'gpu' && this.gpu) {
      try {
        await this.syncPresentationCheckpoint(true);
      } catch (error) {
        this.restoreCheckpointScalars();
        this.disposeGpu();
        this.effective = 'cpu';
        this.fallback = preference !== 'cpu';
        this.detail = preference === 'cpu'
          ? `CPU reference selected explicitly; GPU checkpoint readback failed. ${this.describeError(error)}`
          : `GPU checkpoint readback failed; CPU fallback active. ${this.describeError(error)}`;
        this.emitStatus();
        return this.status;
      }
    }

    if (preference === 'cpu') {
      this.effective = 'cpu';
      this.detail = 'CPU reference selected explicitly.';
      this.emitStatus();
      return this.status;
    }

    const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean(navigator.gpu);
    if (!hasWebGpu) {
      this.disposeGpu();
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
      this.uploadCpuTracerState();
      this.gpuStateDirty = false;
      this.gpuTracersDirty = false;
      this.gpuTicksSinceCheckpoint = 0;
      this.captureCheckpoint();
      this.effective = 'gpu';
      this.detail = preference === 'gpu'
        ? 'GPU selected. Physics, tracers and field rendering stay on WebGPU; full CPU checkpoints update about 5 times/second.'
        : 'Auto selected GPU. Physics, tracers and rendering stay device-local with low-frequency CPU checkpoints.';
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
    if (this.activeStep) return this.activeStep;
    await this.mutationQueue;
    if (!(dt > 0) || !this.cpu.running) return;

    const task = this.effective === 'gpu'
      ? this.stepGpuPhysics(dt)
      : this.stepCpu(dt);
    this.activeStep = task.finally(() => {
      this.activeStep = null;
    });
    return this.activeStep;
  }

  renderGpuFrame(): void {
    if (this.effective !== 'gpu' || !this.gpu) return;
    try {
      if (this.gpuStateDirty) {
        this.uploadCpuFullState();
        this.gpuStateDirty = false;
        this.gpuTicksSinceCheckpoint = 0;
        this.captureCheckpoint();
      }
      if (this.gpuTracersDirty) {
        this.uploadCpuTracerState();
        this.gpuTracersDirty = false;
      }
      this.gpu.renderFrame();
    } catch (error) {
      const replayTicks = this.gpuTicksSinceCheckpoint;
      this.restoreCheckpointScalars();
      this.disposeGpu();
      for (let i = 0; i < replayTicks; i += 1) {
        this.cpu.step();
      }
      this.captureCheckpoint();
      this.fallbackToCpu(
        `GPU presentation failed; replayed ${replayTicks} tick(s) from the last CPU checkpoint. ${this.describeError(error)}`
      );
    }
  }

  loadPreset(id: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      await this.waitForIdle();
      const loaded = this.cpu.loadPreset(id);
      if (loaded) {
        this.gpuStateDirty = true;
        this.gpuTracersDirty = true;
        this.gpuTicksSinceCheckpoint = 0;
        this.captureCheckpoint();
      }
      return loaded;
    });
  }

  clearScene(): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.waitForIdle();
      this.cpu.clearScene();
      this.gpuStateDirty = true;
      this.gpuTracersDirty = true;
      this.gpuTicksSinceCheckpoint = 0;
      this.captureCheckpoint();
    });
  }

  async setToolAt(tool: string, x: number, y: number, wallMaterialId?: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.waitForIdle();
      if (this.effective === 'gpu' && this.gpu && this.gpuTicksSinceCheckpoint > 0) {
        await this.syncPresentationCheckpoint(true);
      }
      this.cpu.setToolAt(tool, x, y, wallMaterialId);
      this.gpuStateDirty = true;
      this.gpuTracersDirty = true;
      this.gpuTicksSinceCheckpoint = 0;
      this.captureCheckpoint();
    });
  }

  ignite(): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.waitForIdle();
      this.cpu.ignite();
    });
  }

  pause(): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.waitForIdle();
      this.cpu.pause();
    });
  }

  dispose(): void {
    this.disposeGpu();
    this.listeners.clear();
  }

  private async stepCpu(dt: number): Promise<void> {
    this.cpu.step(dt);
    this.captureCheckpoint();
  }

  private async stepGpuPhysics(dt: number): Promise<void> {
    const gpu = this.gpu;
    if (!gpu) {
      this.fallbackToCpu('GPU backend was not initialized; CPU fallback active.');
      this.cpu.step(dt);
      this.captureCheckpoint();
      return;
    }

    try {
      if (this.gpuStateDirty) {
        this.uploadCpuFullState();
        this.gpuStateDirty = false;
        this.gpuTicksSinceCheckpoint = 0;
        this.captureCheckpoint();
      }
      if (this.gpuTracersDirty) {
        this.uploadCpuTracerState();
        this.gpuTracersDirty = false;
      }

      this.cpu.time += dt;
      const ignitionActive = this.cpu.ignitionRemaining > 0;
      if (ignitionActive) {
        this.cpu.ignitionRemaining = Math.max(0, this.cpu.ignitionRemaining - dt);
      }

      gpu.stepPhysics(dt, {
        ignitionActive,
        simulationTime: this.cpu.time,
      });

      const [outflow, secondaryReacted] = await Promise.all([
        gpu.readScalarOutflowTotal(),
        gpu.readSecondaryReactionTotal(),
      ]);
      this.updateCpuSmallDiagnostics(outflow, secondaryReacted, dt);
      this.gpuTicksSinceCheckpoint += 1;

      if (this.gpuTicksSinceCheckpoint >= GPU_CHECKPOINT_INTERVAL_TICKS) {
        await this.syncPresentationCheckpoint(true);
      }
    } catch (error) {
      const replayTicks = this.gpuTicksSinceCheckpoint + 1;
      this.restoreCheckpointScalars();
      this.disposeGpu();
      this.fallbackToCpu(
        `GPU runtime failed; replayed ${replayTicks} tick(s) from the last CPU checkpoint. ${this.describeError(error)}`
      );
      for (let i = 0; i < replayTicks; i += 1) {
        this.cpu.step(dt);
      }
      this.captureCheckpoint();
    }
  }

  private updateCpuSmallDiagnostics(
    outflow: { smokeOut: number; volatileOut: number; exhaustOut: number },
    secondaryReacted: number,
    dt: number,
  ): void {
    this.cpu.smokeOutTotal += Math.max(0, outflow.smokeOut);
    this.cpu.volatileOutTotal += Math.max(0, outflow.volatileOut);
    this.cpu.exhaustOutTotal += Math.max(0, outflow.exhaustOut);
    this.cpu.smokeOxidizedTotal += Math.max(0, secondaryReacted);
    this.cpu.lastSecondaryRate = Math.max(0, secondaryReacted) / Math.max(dt, 1e-6);
  }

  private async syncPresentationCheckpoint(includeTracers: boolean): Promise<void> {
    const gpu = this.gpu;
    if (!gpu) return;
    const reads = [
      gpu.readVelocity(),
      gpu.readScalarState(),
      gpu.readFuelState(),
    ] as const;
    const [velocity, scalars, fuel] = await Promise.all(reads);

    this.cpu.u.set(velocity.u);
    this.cpu.v.set(velocity.v);
    this.cpu.temperature.set(scalars.temperature);
    this.cpu.wallTemperature.set(scalars.wallTemperature);
    this.cpu.wallInnerTemperature.set(scalars.wallInnerTemperature);
    this.cpu.wallOuterTemperature.set(scalars.wallOuterTemperature);
    this.cpu.oxygen.set(scalars.oxygen);
    this.cpu.smoke.set(scalars.smoke);
    this.cpu.volatileGas.set(scalars.volatileGas);
    this.cpu.exhaustGas.set(scalars.exhaustGas);
    this.cpu.secondaryResidence.set(scalars.secondaryResidence);
    this.cpu.rawStraw.set(fuel.rawStraw);
    this.cpu.char.set(fuel.char);
    this.cpu.mineralMatter.set(fuel.mineralMatter);
    this.cpu.ash.set(fuel.ash);

    if (includeTracers) {
      const tracerData = await gpu.readTracerState();
      const count = Math.min(this.cpu.tracers.length, Math.floor(tracerData.length / 2));
      for (let i = 0; i < count; i += 1) {
        this.cpu.tracers[i].x = tracerData[i * 2] ?? this.cpu.tracers[i].x;
        this.cpu.tracers[i].y = tracerData[i * 2 + 1] ?? this.cpu.tracers[i].y;
      }
    }

    const raw = this.cpu.sum(this.cpu.rawStraw);
    const charMass = this.cpu.sum(this.cpu.char);
    const pyrolyzed = Math.max(0, this.cpu.initialOrganic - raw);
    this.cpu.pyrolyzedTotal = pyrolyzed;
    this.cpu.charGeneratedTotal = pyrolyzed * DEFAULT_FUEL_PARAMS.charYield;
    this.cpu.volatileGeneratedTotal = pyrolyzed * DEFAULT_FUEL_PARAMS.volatileYield;
    this.cpu.charBurnedTotal = Math.max(0, this.cpu.charGeneratedTotal - charMass);
    this.cpu.exhaustTotal = Math.max(
      0,
      this.cpu.sum(this.cpu.exhaustGas) + this.cpu.exhaustOutTotal,
    );
    this.cpu.lastPressureResidual = this.estimateVelocityResidual();
    this.cpu.measureBoundaryFlux();
    this.gpuTicksSinceCheckpoint = 0;
    this.captureCheckpoint();
  }

  private uploadCpuFullState(): void {
    const gpu = this.gpu;
    if (!gpu) throw new Error('GPU backend is not initialized');
    gpu.uploadAirflowState({
      temperature: this.cpu.temperature,
      wallTemperature: this.cpu.wallTemperature,
      wallInnerTemperature: this.cpu.wallInnerTemperature,
      wallOuterTemperature: this.cpu.wallOuterTemperature,
      wallConductivity: this.cpu.wallConductivity,
      wallMaterial: this.cpu.wallMaterial,
      wallInnerFaceMask: this.cpu.wallInnerFaceMask,
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

  private uploadCpuTracerState(): void {
    const gpu = this.gpu;
    if (!gpu) throw new Error('GPU backend is not initialized');
    const positions = new Float32Array(this.cpu.tracers.length * 2);
    for (let i = 0; i < this.cpu.tracers.length; i += 1) {
      positions[i * 2] = this.cpu.tracers[i].x;
      positions[i * 2 + 1] = this.cpu.tracers[i].y;
    }
    gpu.uploadTracerState(positions);
  }

  private async ensureGpu(): Promise<void> {
    if (this.gpu) return;
    const gpu = new GpuSimulationBackend({
      nx: NX,
      ny: NY,
      h: H,
      simWidth: SIM_WIDTH,
      simHeight: SIM_HEIGHT,
      tracerCount: this.cpu.tracers.length,
    });
    await gpu.initialize();
    if (this.renderCanvas) gpu.attachRenderCanvas(this.renderCanvas);
    this.gpu = gpu;
  }

  private disposeGpu(): void {
    this.gpu?.dispose();
    this.gpu = null;
    this.gpuStateDirty = true;
    this.gpuTracersDirty = true;
    this.gpuTicksSinceCheckpoint = 0;
  }

  private fallbackToCpu(detail: string): void {
    this.effective = 'cpu';
    this.fallback = true;
    this.detail = detail;
    this.emitStatus();
  }

  private captureCheckpoint(): void {
    this.checkpoint = {
      time: this.cpu.time,
      ignitionRemaining: this.cpu.ignitionRemaining,
      pyrolyzedTotal: this.cpu.pyrolyzedTotal,
      charGeneratedTotal: this.cpu.charGeneratedTotal,
      charBurnedTotal: this.cpu.charBurnedTotal,
      volatileGeneratedTotal: this.cpu.volatileGeneratedTotal,
      volatileBurnedTotal: this.cpu.volatileBurnedTotal,
      smokeGeneratedTotal: this.cpu.smokeGeneratedTotal,
      smokeOxidizedTotal: this.cpu.smokeOxidizedTotal,
      exhaustTotal: this.cpu.exhaustTotal,
      smokeOutTotal: this.cpu.smokeOutTotal,
      volatileOutTotal: this.cpu.volatileOutTotal,
      exhaustOutTotal: this.cpu.exhaustOutTotal,
      lastSecondaryRate: this.cpu.lastSecondaryRate,
      lastPressureResidual: this.cpu.lastPressureResidual,
      lastInflow: this.cpu.lastInflow,
      lastOutflow: this.cpu.lastOutflow,
    };
  }

  private restoreCheckpointScalars(): void {
    const c = this.checkpoint;
    if (!c) return;
    this.cpu.time = c.time;
    this.cpu.ignitionRemaining = c.ignitionRemaining;
    this.cpu.pyrolyzedTotal = c.pyrolyzedTotal;
    this.cpu.charGeneratedTotal = c.charGeneratedTotal;
    this.cpu.charBurnedTotal = c.charBurnedTotal;
    this.cpu.volatileGeneratedTotal = c.volatileGeneratedTotal;
    this.cpu.volatileBurnedTotal = c.volatileBurnedTotal;
    this.cpu.smokeGeneratedTotal = c.smokeGeneratedTotal;
    this.cpu.smokeOxidizedTotal = c.smokeOxidizedTotal;
    this.cpu.exhaustTotal = c.exhaustTotal;
    this.cpu.smokeOutTotal = c.smokeOutTotal;
    this.cpu.volatileOutTotal = c.volatileOutTotal;
    this.cpu.exhaustOutTotal = c.exhaustOutTotal;
    this.cpu.lastSecondaryRate = c.lastSecondaryRate;
    this.cpu.lastPressureResidual = c.lastPressureResidual;
    this.cpu.lastInflow = c.lastInflow;
    this.cpu.lastOutflow = c.lastOutflow;
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

  private async waitForIdle(): Promise<void> {
    const active = this.activeStep;
    if (active) await active;
  }

  private enqueueMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}
