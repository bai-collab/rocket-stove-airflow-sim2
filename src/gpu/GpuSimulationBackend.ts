import { compute, init, type Compute, type Gpu } from 'vgpu';
import buoyancyWgsl from './shaders/airflow/buoyancy.wgsl';
import { GpuFieldRegistry, type CpuAirflowSnapshot } from './GpuFieldRegistry';

export interface SimulationBackend {
  initialize(): Promise<void> | void;
  reset(): void;
  step(dt: number): void;
  dispose(): void;
}

/**
 * Phase 3 VGPU backend.
 *
 * CPU Physics v3 is still the reference implementation. This backend currently
 * migrates only the buoyancy pass so CPU/GPU parity can be measured before
 * advection, divergence, pressure and projection move to the GPU.
 */
export class GpuSimulationBackend implements SimulationBackend {
  private readonly cellCount: number;
  private gpu: Gpu | null = null;
  private fields: GpuFieldRegistry | null = null;
  private buoyancy: Compute | null = null;
  private initialized = false;

  constructor(cellCount: number) {
    if (!Number.isInteger(cellCount) || cellCount <= 0) {
      throw new RangeError('cellCount must be a positive integer');
    }
    this.cellCount = cellCount;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.gpu = await init();
    this.fields = new GpuFieldRegistry(this.gpu, this.cellCount);
    this.buoyancy = compute(this.gpu, buoyancyWgsl, {
      label: 'rocket-stove-airflow:buoyancy',
    });
    this.initialized = true;
  }

  uploadAirflowState(snapshot: CpuAirflowSnapshot): void {
    this.requireFields().upload(snapshot);
  }

  step(dt: number): void {
    if (!(dt > 0)) return;
    const fields = this.requireFields();
    const buoyancy = this.requireBuoyancy();

    buoyancy
      .set({
        params: {
          dt,
          ambient_temperature: 25,
          max_delta_temperature: 160,
          acceleration_scale: 40,
        },
        temperature: fields.temperature,
        solid: fields.solid,
        velocity_src: fields.velocity.read,
        velocity_dst: fields.velocity.write,
      })
      .dispatch(Math.ceil(this.cellCount / 64));

    fields.velocity.swap();
  }

  async readVelocity(): Promise<{ u: Float32Array; v: Float32Array }> {
    return this.requireFields().readVelocity();
  }

  reset(): void {
    if (!this.initialized) return;
    this.requireFields().resetVelocity();
  }

  dispose(): void {
    if (!this.initialized) return;
    this.fields?.dispose();
    this.gpu?.dispose();
    this.fields = null;
    this.buoyancy = null;
    this.gpu = null;
    this.initialized = false;
  }

  private requireFields(): GpuFieldRegistry {
    if (!this.fields) throw new Error('GpuSimulationBackend.initialize() must run first');
    return this.fields;
  }

  private requireBuoyancy(): Compute {
    if (!this.buoyancy) throw new Error('GpuSimulationBackend.initialize() must run first');
    return this.buoyancy;
  }
}
