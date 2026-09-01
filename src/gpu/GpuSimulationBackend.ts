import { compute, init, type Compute, type Gpu } from 'vgpu';
import advectVelocityWgsl from './shaders/airflow/advect-velocity.wgsl';
import buoyancyWgsl from './shaders/airflow/buoyancy.wgsl';
import divergenceWgsl from './shaders/airflow/divergence.wgsl';
import pressureJacobiWgsl from './shaders/airflow/pressure-jacobi.wgsl';
import projectWgsl from './shaders/airflow/project.wgsl';
import { GpuFieldRegistry, type CpuAirflowSnapshot } from './GpuFieldRegistry';

export interface SimulationBackend {
  initialize(): Promise<void> | void;
  reset(): void;
  step(dt: number): void;
  dispose(): void;
}

export type GpuSimulationOptions = {
  nx: number;
  ny: number;
  h?: number;
  pressureIterations?: number;
  maxSpeed?: number;
};

/**
 * Phase 3 VGPU airflow backend.
 *
 * CPU Physics v3 remains authoritative. The GPU currently implements the local
 * airflow chain through pressure projection. Global boundary-flux balancing is
 * intentionally still outside this backend and will move only after local
 * CPU/GPU parity is frozen.
 */
export class GpuSimulationBackend implements SimulationBackend {
  private readonly nx: number;
  private readonly ny: number;
  private readonly h: number;
  private readonly pressureIterations: number;
  private readonly maxSpeed: number;
  private readonly cellCount: number;

  private gpu: Gpu | null = null;
  private fields: GpuFieldRegistry | null = null;
  private buoyancy: Compute | null = null;
  private advectVelocity: Compute | null = null;
  private divergence: Compute | null = null;
  private pressureJacobi: Compute | null = null;
  private project: Compute | null = null;
  private initialized = false;

  constructor(options: GpuSimulationOptions) {
    const { nx, ny, h = 12, pressureIterations = 36, maxSpeed = 180 } = options;
    if (!Number.isInteger(nx) || nx <= 0 || !Number.isInteger(ny) || ny <= 0) {
      throw new RangeError('nx and ny must be positive integers');
    }
    if (!(h > 0) || !Number.isInteger(pressureIterations) || pressureIterations <= 0 || !(maxSpeed > 0)) {
      throw new RangeError('h, pressureIterations and maxSpeed must be positive');
    }
    this.nx = nx;
    this.ny = ny;
    this.h = h;
    this.pressureIterations = pressureIterations;
    this.maxSpeed = maxSpeed;
    this.cellCount = nx * ny;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.gpu = await init();
    this.fields = new GpuFieldRegistry(this.gpu, this.cellCount);
    this.buoyancy = compute(this.gpu, buoyancyWgsl, { label: 'rocket-stove-airflow:buoyancy' });
    this.advectVelocity = compute(this.gpu, advectVelocityWgsl, { label: 'rocket-stove-airflow:advect-velocity' });
    this.divergence = compute(this.gpu, divergenceWgsl, { label: 'rocket-stove-airflow:divergence' });
    this.pressureJacobi = compute(this.gpu, pressureJacobiWgsl, { label: 'rocket-stove-airflow:pressure-jacobi' });
    this.project = compute(this.gpu, projectWgsl, { label: 'rocket-stove-airflow:project' });
    this.initialized = true;
  }

  uploadAirflowState(snapshot: CpuAirflowSnapshot): void {
    this.requireFields().upload(snapshot);
  }

  step(dt: number): void {
    if (!(dt > 0)) return;
    const fields = this.requireFields();
    const workgroups = Math.ceil(this.cellCount / 64);

    this.requirePass(this.buoyancy, 'buoyancy')
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
      .dispatch(workgroups);
    fields.velocity.swap();

    this.requirePass(this.advectVelocity, 'advectVelocity')
      .set({
        params: { dt, h: this.h, nx: this.nx, ny: this.ny },
        solid: fields.solid,
        velocity_src: fields.velocity.read,
        velocity_dst: fields.velocity.write,
      })
      .dispatch(workgroups);
    fields.velocity.swap();

    fields.resetPressure();
    this.requirePass(this.divergence, 'divergence')
      .set({
        params: { h: this.h, nx: this.nx, ny: this.ny, _pad: 0 },
        solid: fields.solid,
        velocity: fields.velocity.read,
        divergence: fields.divergence,
      })
      .dispatch(workgroups);

    const pressurePass = this.requirePass(this.pressureJacobi, 'pressureJacobi');
    for (let iter = 0; iter < this.pressureIterations; iter += 1) {
      pressurePass
        .set({
          params: { h: this.h, nx: this.nx, ny: this.ny, _pad: 0 },
          solid: fields.solid,
          divergence: fields.divergence,
          pressure_src: fields.pressure.read,
          pressure_dst: fields.pressure.write,
        })
        .dispatch(workgroups);
      fields.pressure.swap();
    }

    this.requirePass(this.project, 'project')
      .set({
        params: { h: this.h, max_speed: this.maxSpeed, nx: this.nx, ny: this.ny },
        solid: fields.solid,
        pressure: fields.pressure.read,
        velocity_src: fields.velocity.read,
        velocity_dst: fields.velocity.write,
      })
      .dispatch(workgroups);
    fields.velocity.swap();
  }

  async readVelocity(): Promise<{ u: Float32Array; v: Float32Array }> {
    return this.requireFields().readVelocity();
  }

  async readPressure(): Promise<Float32Array> {
    return this.requireFields().readPressure();
  }

  async readDivergence(): Promise<Float32Array> {
    return this.requireFields().readDivergence();
  }

  reset(): void {
    if (!this.initialized) return;
    const fields = this.requireFields();
    fields.resetVelocity();
    fields.resetPressure();
  }

  dispose(): void {
    if (!this.initialized) return;
    this.fields?.dispose();
    this.gpu?.dispose();
    this.fields = null;
    this.buoyancy = null;
    this.advectVelocity = null;
    this.divergence = null;
    this.pressureJacobi = null;
    this.project = null;
    this.gpu = null;
    this.initialized = false;
  }

  private requireFields(): GpuFieldRegistry {
    if (!this.fields) throw new Error('GpuSimulationBackend.initialize() must run first');
    return this.fields;
  }

  private requirePass(pass: Compute | null, name: string): Compute {
    if (!pass) throw new Error(`GpuSimulationBackend ${name} pass is not initialized`);
    return pass;
  }
}
