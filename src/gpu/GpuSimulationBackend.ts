import {
  compute,
  draw,
  effect,
  frame,
  init,
  surface,
  type Compute,
  type Gpu,
  type StorageBuffer,
} from 'vgpu';
import advectVelocityWgsl from './shaders/airflow/advect-velocity.wgsl';
import boundaryFluxCorrectWgsl from './shaders/airflow/boundary-flux-correct.wgsl';
import boundaryFluxStatsWgsl from './shaders/airflow/boundary-flux-stats.wgsl';
import buoyancyWgsl from './shaders/airflow/buoyancy.wgsl';
import divergenceWgsl from './shaders/airflow/divergence.wgsl';
import pressureJacobiWgsl from './shaders/airflow/pressure-jacobi.wgsl';
import projectWgsl from './shaders/airflow/project.wgsl';
import reduceVec2Wgsl from './shaders/airflow/reduce-vec2.wgsl';
import reduceVec4Wgsl from './shaders/airflow/reduce-vec4.wgsl';
import coolingResidenceWgsl from './shaders/combustion/cooling-residence.wgsl';
import secondaryCombustionWgsl from './shaders/combustion/secondary-combustion.wgsl';
import wallConductionWgsl from './shaders/combustion/wall-conduction.wgsl';
import charOxidationPassWgsl from './shaders/fuel/char-oxidation-pass.wgsl';
import pyrolysisPassWgsl from './shaders/fuel/pyrolysis-pass.wgsl';
import volatileCombustionWgsl from './shaders/fuel/volatile-combustion.wgsl';
import fieldRenderWgsl from './shaders/render/field-render.wgsl';
import packRenderStateWgsl from './shaders/render/pack-render-state.wgsl';
import packTracerRenderStateWgsl from './shaders/render/pack-tracer-render-state.wgsl';
import tracerRenderWgsl from './shaders/render/tracer-render.wgsl';
import advectScalarWgsl from './shaders/scalar/advect-scalar.wgsl';
import openBoundaryExchangeWgsl from './shaders/scalar/open-boundary-exchange.wgsl';
import normalizeScalarWgsl from './shaders/scalar/normalize-scalar.wgsl';
import scalarMassStatsWgsl from './shaders/scalar/scalar-mass-stats.wgsl';
import tracerUpdateWgsl from './shaders/tracer/tracer-update.wgsl';
import { DEFAULT_FUEL_PARAMS } from '../physics/fuel-model.mjs';
import { WALL_CONDUCTION_PARAMS } from '../physics/wall-materials.mjs';
import {
  GpuFieldRegistry,
  type CpuAirflowSnapshot,
  type GpuFuelState,
  type GpuScalarState,
} from './GpuFieldRegistry';

const FUEL = DEFAULT_FUEL_PARAMS;

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
  simWidth?: number;
  simHeight?: number;
  tracerCount?: number;
  pressureIterations?: number;
  maxSpeed?: number;
  traceStep?: number;
};

export type GpuPhysicsStepOptions = {
  ignitionActive?: boolean;
  simulationTime?: number;
};

type PingPongStorage = {
  readonly read: StorageBuffer;
  readonly write: StorageBuffer;
  swap(): void;
};

/**
 * VGPU Physics v3 backend.
 *
 * Phase 5 adds device-local tracer integration and direct WebGPU presentation.
 * The same buffers used by compute passes are consumed by fullscreen field and
 * instanced tracer draws, so presentation no longer requires a full-field CPU
 * readback every physics tick.
 */
export class GpuSimulationBackend implements SimulationBackend {
  private readonly nx: number;
  private readonly ny: number;
  private readonly h: number;
  private readonly simWidth: number;
  private readonly simHeight: number;
  private readonly tracerCount: number;
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
  private reduceVec4: Compute | null = null;
  private boundaryFluxCorrect: Compute | null = null;
  private advectScalar: Compute | null = null;
  private openBoundaryExchange: Compute | null = null;
  private scalarMassStats: Compute | null = null;
  private normalizeScalar: Compute | null = null;
  private pyrolysisPass: Compute | null = null;
  private volatileCombustion: Compute | null = null;
  private charOxidationPass: Compute | null = null;
  private coolingResidence: Compute | null = null;
  private wallConduction: Compute | null = null;
  private secondaryCombustion: Compute | null = null;
  private tracerUpdate: Compute | null = null;
  private packRenderState: Compute | null = null;
  private packTracerRenderState: Compute | null = null;
  private renderSurface: ReturnType<typeof surface> | null = null;
  private fieldEffect: ReturnType<typeof effect> | null = null;
  private tracerDraw: ReturnType<typeof draw> | null = null;
  private initialized = false;

  constructor(options: GpuSimulationOptions) {
    const {
      nx,
      ny,
      h = 12,
      simWidth = nx * h,
      simHeight = ny * h,
      tracerCount = 320,
      pressureIterations = 36,
      maxSpeed = 180,
      traceStep = Math.max(2, h * 0.35),
    } = options;
    if (!Number.isInteger(nx) || nx <= 0 || !Number.isInteger(ny) || ny <= 0) {
      throw new RangeError('nx and ny must be positive integers');
    }
    if (
      !(h > 0) || !(simWidth > 0) || !(simHeight > 0) ||
      !Number.isInteger(tracerCount) || tracerCount <= 0 ||
      !Number.isInteger(pressureIterations) || pressureIterations <= 0 ||
      !(maxSpeed > 0) || !(traceStep > 0)
    ) {
      throw new RangeError('GPU simulation dimensions/counts must be positive');
    }
    this.nx = nx;
    this.ny = ny;
    this.h = h;
    this.simWidth = simWidth;
    this.simHeight = simHeight;
    this.tracerCount = tracerCount;
    this.pressureIterations = pressureIterations;
    this.maxSpeed = maxSpeed;
    this.traceStep = traceStep;
    this.cellCount = nx * ny;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.gpu = await init();
    this.fields = new GpuFieldRegistry(this.gpu, this.cellCount, this.tracerCount);
    this.buoyancy = compute(this.gpu, buoyancyWgsl, { label: 'rocket-stove-airflow:buoyancy' });
    this.advectVelocity = compute(this.gpu, advectVelocityWgsl, { label: 'rocket-stove-airflow:advect-velocity' });
    this.divergence = compute(this.gpu, divergenceWgsl, { label: 'rocket-stove-airflow:divergence' });
    this.pressureJacobi = compute(this.gpu, pressureJacobiWgsl, { label: 'rocket-stove-airflow:pressure-jacobi' });
    this.project = compute(this.gpu, projectWgsl, { label: 'rocket-stove-airflow:project' });
    this.boundaryFluxStats = compute(this.gpu, boundaryFluxStatsWgsl, { label: 'rocket-stove-airflow:boundary-flux-stats' });
    this.reduceVec2 = compute(this.gpu, reduceVec2Wgsl, { label: 'rocket-stove-airflow:reduce-vec2' });
    this.reduceVec4 = compute(this.gpu, reduceVec4Wgsl, { label: 'rocket-stove-airflow:reduce-vec4' });
    this.boundaryFluxCorrect = compute(this.gpu, boundaryFluxCorrectWgsl, { label: 'rocket-stove-airflow:boundary-flux-correct' });
    this.advectScalar = compute(this.gpu, advectScalarWgsl, { label: 'rocket-stove-airflow:advect-scalar' });
    this.openBoundaryExchange = compute(this.gpu, openBoundaryExchangeWgsl, { label: 'rocket-stove-airflow:open-boundary-scalars' });
    this.scalarMassStats = compute(this.gpu, scalarMassStatsWgsl, { label: 'rocket-stove-airflow:scalar-mass-stats' });
    this.normalizeScalar = compute(this.gpu, normalizeScalarWgsl, { label: 'rocket-stove-airflow:normalize-scalar' });
    this.pyrolysisPass = compute(this.gpu, pyrolysisPassWgsl, { label: 'rocket-stove-airflow:pyrolysis' });
    this.volatileCombustion = compute(this.gpu, volatileCombustionWgsl, { label: 'rocket-stove-airflow:volatile-combustion' });
    this.charOxidationPass = compute(this.gpu, charOxidationPassWgsl, { label: 'rocket-stove-airflow:char-oxidation' });
    this.coolingResidence = compute(this.gpu, coolingResidenceWgsl, { label: 'rocket-stove-airflow:cooling-residence' });
    this.wallConduction = compute(this.gpu, wallConductionWgsl, { label: 'rocket-stove-airflow:wall-conduction' });
    this.secondaryCombustion = compute(this.gpu, secondaryCombustionWgsl, { label: 'rocket-stove-airflow:secondary-combustion' });
    this.tracerUpdate = compute(this.gpu, tracerUpdateWgsl, { label: 'rocket-stove-airflow:tracer-update' });
    this.packRenderState = compute(this.gpu, packRenderStateWgsl, { label: 'rocket-stove-airflow:pack-render-state' });
    this.packTracerRenderState = compute(this.gpu, packTracerRenderStateWgsl, { label: 'rocket-stove-airflow:pack-tracer-render-state' });
    this.initialized = true;
  }

  attachRenderCanvas(canvas: HTMLCanvasElement): void {
    const gpu = this.requireGpu();
    const fields = this.requireFields();
    this.renderSurface = surface(gpu, canvas, { dpr: [1, 2] });
    this.fieldEffect = effect(gpu, fieldRenderWgsl, { label: 'rocket-stove-airflow:field-render' });
    this.tracerDraw = draw(gpu, {
      shader: tracerRenderWgsl,
      label: 'rocket-stove-airflow:tracer-render',
      geometry: {
        vertexBuffers: [fields.tracers.gpu],
        vertexBufferLayouts: [{
          arrayStride: 16,
          stepMode: 'instance',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }],
        }],
        vertexCount: 6,
      },
      instances: this.tracerCount,
    });
  }

  uploadAirflowState(snapshot: CpuAirflowSnapshot): void {
    this.requireFields().upload(snapshot);
    this.updateRenderState();
  }

  uploadTracerState(interleavedPositions: Float32Array): void {
    this.requireFields().uploadTracers(interleavedPositions);
    this.updateTracerRenderState();
  }

  step(dt: number): void {
    this.runTransport(dt, true);
    this.runWallThermalExchange(dt);
    this.updateRenderState();
  }

  stepTransport(dt: number): void {
    this.runTransport(dt, false);
    this.updateRenderState();
  }

  stepPhysics(dt: number, options: GpuPhysicsStepOptions = {}): void {
    if (!(dt > 0)) return;
    const workgroups = Math.ceil(this.cellCount / 64);
    this.runFuelTransformation(dt, Boolean(options.ignitionActive), workgroups);
    this.runTransport(dt, false);
    this.runWallThermalExchange(dt);
    this.runCoolingResidence(dt, workgroups);
    this.runSecondaryCombustion(dt, workgroups);
    this.exchangeOpenBoundaryScalars(dt, workgroups);
    this.runTracers(dt, options.simulationTime ?? 0);
    this.updateRenderState();
  }

  renderFrame(): void {
    const gpu = this.requireGpu();
    const fields = this.requireFields();
    const target = this.renderSurface;
    const fieldEffect = this.fieldEffect;
    const tracerDraw = this.tracerDraw;
    if (!target || !fieldEffect || !tracerDraw) return;

    fieldEffect.set({
      params: {
        h: this.h,
        sim_width: this.simWidth,
        sim_height: this.simHeight,
        ambient_temperature: FUEL.ambientTemperature,
        nx: this.nx,
        ny: this.ny,
        _pad0: 0,
        _pad1: 0,
      },
      solid: fields.solid,
      velocity: fields.velocity.read,
      render_state: fields.renderState,
      ash: fields.ash,
      wall_material: fields.wallMaterial,
      wall_thermal: fields.wallThermalProperties,
      wall_inner_temperature: fields.wallInnerTemperature.read,
      wall_outer_temperature: fields.wallOuterTemperature.read,
    });

    tracerDraw.set({
      params: {
        sim_width: this.simWidth,
        sim_height: this.simHeight,
        h: this.h,
        radius: 2.0,
        nx: this.nx,
        ny: this.ny,
        tracer_count: this.tracerCount,
        _pad0: 0,
      },
    });

    frame(gpu, (f) => {
      f.pass(target, (pass) => {
        pass.draw(fieldEffect);
        pass.draw(tracerDraw);
      });
    });
  }

  async readVelocity(): Promise<{ u: Float32Array; v: Float32Array }> {
    return this.requireFields().readVelocity();
  }

  async readScalarState(): Promise<GpuScalarState> {
    return this.requireFields().readScalarState();
  }

  async readFuelState(): Promise<GpuFuelState> {
    return this.requireFields().readFuelState();
  }

  async readTracerState(): Promise<Float32Array> {
    return this.requireFields().readTracers();
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

  async readScalarOutflowTotal(): Promise<{ smokeOut: number; volatileOut: number; exhaustOut: number }> {
    return this.requireFields().readScalarOutflowTotal();
  }

  async readSecondaryReactionTotal(): Promise<number> {
    return this.requireFields().readSecondaryReactionTotal();
  }

  reset(): void {
    if (!this.initialized) return;
    const fields = this.requireFields();
    fields.resetVelocity();
    fields.resetPressure();
    fields.resetBoundaryFlux();
    fields.resetScalarOutflow();
    fields.resetScalarMassStats();
    fields.resetSecondaryReaction();
  }

  dispose(): void {
    if (!this.initialized && !this.gpu && !this.fields) return;
    this.renderSurface = null;
    this.fieldEffect = null;
    this.tracerDraw = null;
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
    this.reduceVec4 = null;
    this.boundaryFluxCorrect = null;
    this.advectScalar = null;
    this.openBoundaryExchange = null;
    this.scalarMassStats = null;
    this.normalizeScalar = null;
    this.pyrolysisPass = null;
    this.volatileCombustion = null;
    this.charOxidationPass = null;
    this.coolingResidence = null;
    this.wallConduction = null;
    this.secondaryCombustion = null;
    this.tracerUpdate = null;
    this.packRenderState = null;
    this.packTracerRenderState = null;
    this.gpu = null;
    this.initialized = false;
  }

  private runFuelTransformation(dt: number, ignitionActive: boolean, workgroups: number): void {
    const fields = this.requireFields();

    this.requirePass(this.pyrolysisPass, 'pyrolysisPass')
      .set({
        params: {
          dt,
          ignition_active: ignitionActive ? 1 : 0,
          pyrolysis_start_temperature: FUEL.pyrolysisStartTemperature,
          pyrolysis_full_temperature: FUEL.pyrolysisFullTemperature,
          pyrolysis_rate: FUEL.pyrolysisRate,
          char_yield: FUEL.charYield,
          volatile_yield: FUEL.volatileYield,
          ignition_heat_rate: FUEL.ignitionHeatRate,
          ambient_temperature: FUEL.ambientTemperature,
          max_temperature: FUEL.maxTemperature,
          cell_count: this.cellCount,
          _pad0: 0,
        },
        fuel_mask: fields.fuelMask,
        raw_straw: fields.rawStraw,
        char_mass: fields.char,
        volatile_gas: fields.volatileGas.read,
        temperature: fields.temperature.read,
      })
      .dispatch(workgroups);

    this.requirePass(this.volatileCombustion, 'volatileCombustion')
      .set({
        params: {
          dt,
          h: this.h,
          burn_start_temperature: FUEL.volatileBurnStartTemperature,
          burn_full_temperature: FUEL.volatileBurnFullTemperature,
          burn_rate: FUEL.volatileBurnRate,
          oxygen_use: FUEL.volatileOxygenUse,
          heat_gain: FUEL.volatileHeatGain,
          clean_smoke_yield: FUEL.cleanSmokeYield,
          dirty_smoke_yield: FUEL.dirtySmokeYield,
          max_temperature: FUEL.maxTemperature,
          ambient_temperature: FUEL.ambientTemperature,
          nx: this.nx,
          ny: this.ny,
        },
        fuel_mask: fields.fuelMask,
        velocity: fields.velocity.read,
        volatile_gas: fields.volatileGas.read,
        oxygen: fields.oxygen.read,
        temperature: fields.temperature.read,
        exhaust_gas: fields.exhaustGas.read,
        smoke: fields.smoke.read,
      })
      .dispatch(workgroups);

    this.requirePass(this.charOxidationPass, 'charOxidationPass')
      .set({
        params: {
          dt,
          oxidation_rate: FUEL.charOxidationRate,
          oxygen_use: FUEL.charOxygenUse,
          heat_gain: FUEL.charHeatGain,
          ash_exposure_per_char: FUEL.ashExposurePerCharOxidized,
          max_temperature: FUEL.maxTemperature,
          ambient_temperature: FUEL.ambientTemperature,
          cell_count: this.cellCount,
          _pad0: 0,
        },
        fuel_mask: fields.fuelMask,
        char_mass: fields.char,
        oxygen: fields.oxygen.read,
        temperature: fields.temperature.read,
        exhaust_gas: fields.exhaustGas.read,
        mineral_matter: fields.mineralMatter,
        ash: fields.ash,
      })
      .dispatch(workgroups);
  }

  private runWallThermalExchange(dt: number): void {
    const fields = this.requireFields();
    const workgroups = Math.ceil(this.cellCount / 64);
    this.requirePass(this.wallConduction, 'wallConduction')
      .set({
        params: {
          dt,
          ambient_temperature: FUEL.ambientTemperature,
          max_temperature: FUEL.maxTemperature,
          coupling_rate: WALL_CONDUCTION_PARAMS.couplingRate,
          wall_heat_capacity: WALL_CONDUCTION_PARAMS.wallHeatCapacity,
          surface_heat_capacity: WALL_CONDUCTION_PARAMS.surfaceHeatCapacity,
          through_wall_rate: WALL_CONDUCTION_PARAMS.throughWallRate,
          reference_conductivity: WALL_CONDUCTION_PARAMS.referenceConductivity,
          emissivity: WALL_CONDUCTION_PARAMS.emissivity,
          stefan_boltzmann: WALL_CONDUCTION_PARAMS.stefanBoltzmann,
          radiation_scale: WALL_CONDUCTION_PARAMS.radiationScale,
          nx: this.nx,
          ny: this.ny,
          _pad0: 0,
          _pad1: 0,
          _pad2: 0,
        },
        solid: fields.solid,
        wall_thermal: fields.wallThermalProperties,
        temperature_src: fields.temperature.read,
        temperature_dst: fields.temperature.write,
        wall_inner_temperature_src: fields.wallInnerTemperature.read,
        wall_inner_temperature_dst: fields.wallInnerTemperature.write,
        wall_outer_temperature_src: fields.wallOuterTemperature.read,
        wall_outer_temperature_dst: fields.wallOuterTemperature.write,
      })
      .dispatch(workgroups);
    fields.temperature.swap();
    fields.wallInnerTemperature.swap();
    fields.wallOuterTemperature.swap();
  }

  private runCoolingResidence(dt: number, workgroups: number): void {
    const fields = this.requireFields();
    this.requirePass(this.coolingResidence, 'coolingResidence')
      .set({
        params: {
          dt,
          ambient_temperature: FUEL.ambientTemperature,
          max_temperature: FUEL.maxTemperature,
          cooling_rate: 0.018,
          residence_max: 2,
          residence_decay_rate: 1.6,
          reactive_threshold: 0.0005,
          moving_threshold: 1.5,
          hot_threshold: 260,
          _pad0: 0,
          nx: this.nx,
          ny: this.ny,
        },
        solid: fields.solid,
        velocity: fields.velocity.read,
        temperature: fields.temperature.read,
        oxygen: fields.oxygen.read,
        smoke: fields.smoke.read,
        volatile_gas: fields.volatileGas.read,
        residence: fields.secondaryResidence.read,
      })
      .dispatch(workgroups);
  }

  private runSecondaryCombustion(dt: number, workgroups: number): void {
    const fields = this.requireFields();
    fields.resetSecondaryReaction();
    this.requirePass(this.secondaryCombustion, 'secondaryCombustion')
      .set({
        params: {
          dt,
          h: this.h,
          oxidation_rate: FUEL.secondarySmokeOxidationRate,
          oxygen_use: FUEL.secondarySmokeOxygenUse,
          heat_gain: FUEL.secondaryHeatGain,
          max_temperature: FUEL.maxTemperature,
          ambient_temperature: FUEL.ambientTemperature,
          residence_scale: 0.75,
          _pad0: 0,
          nx: this.nx,
          ny: this.ny,
          _pad1: 0,
          _pad2: 0,
        },
        solid: fields.solid,
        velocity: fields.velocity.read,
        smoke: fields.smoke.read,
        oxygen: fields.oxygen.read,
        exhaust_gas: fields.exhaustGas.read,
        temperature: fields.temperature.read,
        residence: fields.secondaryResidence.read,
        reaction_stats: fields.secondaryReaction.write,
      })
      .dispatch(workgroups);
    fields.secondaryReaction.swap();
    this.reduceVec2Buffer(fields.secondaryReaction, this.cellCount);
  }

  private runTracers(dt: number, simulationTime: number): void {
    const fields = this.requireFields();
    this.requirePass(this.tracerUpdate, 'tracerUpdate')
      .set({
        params: {
          dt,
          h: this.h,
          sim_width: this.simWidth,
          sim_height: this.simHeight,
          sim_time: simulationTime,
          tracer_count: this.tracerCount,
          nx: this.nx,
          ny: this.ny,
        },
        solid: fields.solid,
        velocity: fields.velocity.read,
        tracers: fields.tracers,
      })
      .dispatch(Math.ceil(this.tracerCount / 64));
  }

  private updateRenderState(): void {
    const fields = this.requireFields();
    this.requirePass(this.packRenderState, 'packRenderState')
      .set({
        params: {
          cell_count: this.cellCount,
          _pad0: 0,
          _pad1: 0,
          _pad2: 0,
        },
        temperature: fields.temperature.read,
        smoke: fields.smoke.read,
        raw_straw: fields.rawStraw,
        char_mass: fields.char,
        render_state: fields.renderState,
        solid: fields.solid,
        wall_inner_temperature: fields.wallInnerTemperature.read,
        wall_outer_temperature: fields.wallOuterTemperature.read,
      })
      .dispatch(Math.ceil(this.cellCount / 64));
    this.updateTracerRenderState();
  }

  private updateTracerRenderState(): void {
    const fields = this.requireFields();
    this.requirePass(this.packTracerRenderState, 'packTracerRenderState')
      .set({
        params: {
          h: this.h,
          nx: this.nx,
          ny: this.ny,
          tracer_count: this.tracerCount,
          _pad0: 0,
          _pad1: 0,
          _pad2: 0,
          _pad3: 0,
        },
        temperature: fields.temperature.read,
        tracers: fields.tracers,
      })
      .dispatch(Math.ceil(this.tracerCount / 64));
  }

  private runTransport(dt: number, includeOpenBoundaryExchange: boolean): void {
    if (!(dt > 0)) return;
    const fields = this.requireFields();
    const workgroups = Math.ceil(this.cellCount / 64);

    this.requirePass(this.buoyancy, 'buoyancy')
      .set({
        params: {
          dt,
          ambient_temperature: FUEL.ambientTemperature,
          max_delta_temperature: FUEL.maxTemperature - FUEL.ambientTemperature,
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
    if (includeOpenBoundaryExchange) {
      this.exchangeOpenBoundaryScalars(dt, workgroups);
    }
  }

  private advectScalarFields(dt: number, workgroups: number): void {
    const fields = this.requireFields();
    this.advectOneScalar(fields.temperature, FUEL.ambientTemperature, dt, workgroups);
    this.advectOneScalar(fields.oxygen, 1, dt, workgroups);
    this.advectOneScalar(fields.smoke, 0, dt, workgroups, true);
    this.advectOneScalar(fields.volatileGas, 0, dt, workgroups, true);
    this.advectOneScalar(fields.exhaustGas, 0, dt, workgroups, true);
    this.advectOneScalar(fields.secondaryResidence, 0, dt, workgroups);
  }

  private advectOneScalar(
    pair: PingPongStorage,
    fallback: number,
    dt: number,
    workgroups: number,
    conserve = false,
  ): void {
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
    if (conserve) this.conserveScalar(pair, workgroups);
  }

  private conserveScalar(pair: PingPongStorage, workgroups: number): void {
    const fields = this.requireFields();
    fields.resetScalarMassStats();
    this.requirePass(this.scalarMassStats, 'scalarMassStats')
      .set({
        params: {
          cell_count: this.cellCount,
          _pad0: 0,
          _pad1: 0,
          _pad2: 0,
        },
        solid: fields.solid,
        scalar_src: pair.write,
        scalar_dst: pair.read,
        stats: fields.scalarMassStats.write,
      })
      .dispatch(workgroups);
    fields.scalarMassStats.swap();
    this.reduceVec4Buffer(fields.scalarMassStats, this.cellCount);

    this.requirePass(this.normalizeScalar, 'normalizeScalar')
      .set({
        params: {
          source_epsilon: 1e-8,
          cell_count: this.cellCount,
          _pad0: 0,
          _pad1: 0,
        },
        solid: fields.solid,
        scalar: pair.read,
        totals: fields.scalarMassStats.read,
      })
      .dispatch(workgroups);
  }

  private exchangeOpenBoundaryScalars(dt: number, workgroups: number): void {
    const fields = this.requireFields();
    fields.resetScalarOutflow();

    this.requirePass(this.openBoundaryExchange, 'openBoundaryExchange')
      .set({
        params: {
          dt,
          h: this.h,
          ambient_temperature: FUEL.ambientTemperature,
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

    this.reduceVec4Buffer(fields.scalarOutflow, this.cellCount);
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

  private reduceVec4Buffer(pair: PingPongStorage, initialCount: number): void {
    const reduce = this.requirePass(this.reduceVec4, 'reduceVec4');
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

  private requireGpu(): Gpu {
    if (!this.gpu) throw new Error('GpuSimulationBackend.initialize() must run first');
    return this.gpu;
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
