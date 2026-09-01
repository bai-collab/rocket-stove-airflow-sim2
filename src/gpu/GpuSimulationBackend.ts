import { compute, init, type Compute, type Gpu, type StorageBuffer } from 'vgpu';
import advectVelocityWgsl from './shaders/airflow/advect-velocity.wgsl';
import boundaryFluxCorrectWgsl from './shaders/airflow/boundary-flux-correct.wgsl';
import boundaryFluxStatsWgsl from './shaders/airflow/boundary-flux-stats.wgsl';
import buoyancyWgsl from './shaders/airflow/buoyancy.wgsl';
import divergenceWgsl from './shaders/airflow/divergence.wgsl';
import pressureJacobiWgsl from './shaders/airflow/pressure-jacobi.wgsl';
import projectWgsl from './shaders/airflow/project.wgsl';
import reduceVec2Wgsl from './shaders/airflow/reduce-vec2.wgsl';
import advectScalarWgsl from './shaders/scalar/advect-scalar.wgsl';
import openBoundaryExchangeWgsl from './shaders/scalar/open-boundary-exchange.wgsl';
import { GpuFieldRegistry, type CpuAirflowSnapshot, type GpuScalarState } from './GpuFieldRegistry';

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
  traceStep?: number;
};

type PingPongStorage = {
  readonly read: StorageBuffer;
  readonly write: StorageBuffer;
  swap(): void;
};

/**
 * Phase 3B VGPU transport backend.
 *
 * CPU Physics v3 remains authoritative. Device-local migration now includes
 * airflow plus scalar advection/open-boundary exchange. Fuel transformation,
 * cooling, secondary reactions and tracer integration still remain on CPU.
 */
export class GpuSimulationBackend implements SimulationBackend {
  private readonly nx: number;
  private readonly ny: number;
  private readonly h: number;
  private readonly pressureIterations: number;
  private readonly maxSpeed: number;
  private readonly traceStep: number;
  private readonly cellCount: number;

  private gpu: Gpu | null = null;
  private fields: GpuFieldRegistry | null = null;
  private buoyancy: Compute | null = null;
  private advectVelocity: Compute | null = null;
  private divergence: Compute | null = null;
  private pressureJacobi: Compute | null = null;
  private project: Compute | null = null;
  private boundaryFluxStats: Compute | null = null;
  private reduceVec2: Compute | null = null;
  private boundaryFluxCorrect: Compute | null = null;
  private advectScalar: Compute | null = null;
  private openBoundaryExchange: Compute | null = null;
  private initialized = false;

  constructor(options: GpuSimulationOptions) {
    const {
      nx,
      ny,
      h = 12,
      pressureIterations = 36,
      maxSpeed = 180,
      traceStep = Math.max(2, h * 0.35),
    } = options;
    if (!Number.isInteger(nx) || nx <= 0 || !Number.isInteger(ny) || ny <= 0) {
      throw new RangeError('nx and ny must be positive integers');
    }
    if (
      !(h > 0) ||
      !Number.isInteger(pressureIterations) || pressureIterations <= 0 ||
      !(maxSpeed > 0) ||
      !(traceStep > 0)
    ) {
      throw new RangeError('h, pressureIterations, maxSpeed and traceStep must be positive');
    }
    this.nx = nx;
    this.ny = ny;
    this.h = h;
    this.pressureIterations = pressureIterations;
    this.maxSpeed = maxSpeed;
    this.traceStep = traceStep;
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
    this.boundaryFluxStats = compute(this.gpu, boundaryFluxStatsWgsl, { label: 'rocket-stove-airflow:boundary-flux-stats' });
    this.reduceVec2 = compute(this.gpu, reduceVec2Wgsl, { label: 'rocket-stove-airflow:reduce-vec2' });
    this.boundaryFluxCorrect = compute(this.gpu, boundaryFluxCorrectWgsl, { label: 'rocket-stove-airflow:boundary-flux-correct' });
    this.advectScalar = compute(this.gpu, advectScalarWgsl, { label: 'rocket-stove-airflow:advect-scalar' });
    this.openBoundaryExchange = compute(this.gpu, openBoundaryExchangeWgsl, { label: 'rocket-stove-airflow:open-boundary-scalars' });
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
        temperature: fields.temperature.read,
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

    this.balanceBoundaryFlux(workgroups);
    this.advectScalarFields(dt, workgroups);
    this.exchangeOpenBoundaryScalars(dt, workgroups);
  }

  async readVelocity(): Promise<{ u: Float32Array; v: Float32Array }> {
    return this.requireFields().readVelocity();
  }

  async readScalarState(): Promise<GpuScalarState> {
    return this.requireFields().readScalarState();
  }

  async readPressure(): Promise<Float32Array> {
    return this.requireFields().readPressure();
  }

  async readDivergence(): Promise<Float32Array> {
    return this.requireFields().readDivergence();
  }

  async readBoundaryFluxTotal(): Promise<{ netOutward: number; faceCount: number }> {
    return this.requireFields().readBoundaryFluxTotal();
  }

  async readScalarOutflowTotal(): Promise<{ smokeOut: number; volatileOut: number }> {
    return this.requireFields().readScalarOutflowTotal();
  }

  reset(): void {
    if (!this.initialized) return;
    const fields = this.requireFields();
    fields.resetVelocity();
    fields.resetPressure();
    fields.resetBoundaryFlux();
    fields.resetScalarOutflow();
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
    this.boundaryFluxStats = null;
    this.reduceVec2 = null;
    this.boundaryFluxCorrect = null;
    this.advectScalar = null;
    this.openBoundaryExchange = null;
    this.gpu = null;
    this.initialized = false;
  }

  private advectScalarFields(dt: number, workgroups: number): void {
    const fields = this.requireFields();
    this.advectOneScalar(fields.temperature, 25, dt, workgroups);
    this.advectOneScalar(fields.oxygen, 1, dt, workgroups);
    this.advectOneScalar(fields.smoke, 0, dt, workgroups);
    this.advectOneScalar(fields.volatileGas, 0, dt, workgroups);
    this.advectOneScalar(fields.exhaustGas, 0, dt, workgroups);
    this.advectOneScalar(fields.secondaryResidence, 0, dt, workgroups);
  }

  private advectOneScalar(pair: PingPongStorage, fallback: number, dt: number, workgroups: number): void {
    const fields = this.requireFields();
    this.requirePass(this.advectScalar, 'advectScalar')
      .set({
        params: {
          dt,
          h: this.h,
          fallback,
          trace_step: this.traceStep,
          nx: this.nx,
          ny: this.ny,
          wall_safe: 1,
          _pad: 0,
        },
        solid: fields.solid,
        velocity: fields.velocity.read,
        scalar_src: pair.read,
        scalar_dst: pair.write,
      })
      .dispatch(workgroups);
    pair.swap();
  }

  private exchangeOpenBoundaryScalars(dt: number, workgroups: number): void {
    const fields = this.requireFields();
    fields.resetScalarOutflow();

    this.requirePass(this.openBoundaryExchange, 'openBoundaryExchange')
      .set({
        params: {
          dt,
          h: this.h,
          ambient_temperature: 25,
          ambient_oxygen: 1,
          nx: this.nx,
          ny: this.ny,
          _pad0: 0,
          _pad1: 0,
        },
        solid: fields.solid,
        velocity: fields.velocity.read,
        temperature: fields.temperature.read,
        oxygen: fields.oxygen.read,
        smoke: fields.smoke.read,
        volatile_gas: fields.volatileGas.read,
        exhaust_gas: fields.exhaustGas.read,
        outflow_stats: fields.scalarOutflow.write,
      })
      .dispatch(workgroups);
    fields.scalarOutflow.swap();

    this.reduceVec2Buffer(fields.scalarOutflow, this.cellCount);
  }

  private balanceBoundaryFlux(workgroups: number): void {
    const fields = this.requireFields();
    fields.resetBoundaryFlux();

    this.requirePass(this.boundaryFluxStats, 'boundaryFluxStats')
      .set({
        params: { nx: this.nx, ny: this.ny, _pad0: 0, _pad1: 0 },
        solid: fields.solid,
        velocity: fields.velocity.read,
        stats: fields.boundaryFlux.write,
      })
      .dispatch(workgroups);
    fields.boundaryFlux.swap();

    this.reduceVec2Buffer(fields.boundaryFlux, this.cellCount);

    this.requirePass(this.boundaryFluxCorrect, 'boundaryFluxCorrect')
      .set({
        params: { nx: this.nx, ny: this.ny, _pad0: 0, _pad1: 0 },
        solid: fields.solid,
        reduced_stats: fields.boundaryFlux.read,
        velocity_src: fields.velocity.read,
        velocity_dst: fields.velocity.write,
      })
      .dispatch(workgroups);
    fields.velocity.swap();
  }

  private reduceVec2Buffer(pair: PingPongStorage, initialCount: number): void {
    const reduce = this.requirePass(this.reduceVec2, 'reduceVec2');
    let inputCount = initialCount;
    while (inputCount > 1) {
      const outputCount = Math.ceil(inputCount / 2);
      reduce
        .set({
          params: { input_count: inputCount, _pad0: 0, _pad1: 0, _pad2: 0 },
          src: pair.read,
          dst: pair.write,
        })
        .dispatch(Math.ceil(outputCount / 64));
      pair.swap();
      inputCount = outputCount;
    }
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
