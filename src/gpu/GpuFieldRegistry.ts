import { pingPongStorage, storage, type Buffer, type Gpu, type StorageBuffer } from 'vgpu';
import { DEFAULT_FUEL_PARAMS } from '../physics/fuel-model.mjs';

export type CpuAirflowSnapshot = {
  temperature: Float32Array;
  solid: Uint8Array | Uint32Array;
  u: Float32Array;
  v: Float32Array;
  oxygen?: Float32Array;
  smoke?: Float32Array;
  volatileGas?: Float32Array;
  exhaustGas?: Float32Array;
  secondaryResidence?: Float32Array;
  /** Compatibility average; inner/outer values take precedence when present. */
  wallTemperature?: Float32Array;
  wallInnerTemperature?: Float32Array;
  wallOuterTemperature?: Float32Array;
  wallConductivity?: Float32Array;
  wallMaterial?: Uint8Array | Uint32Array;
  wallInnerFaceMask?: Uint8Array | Uint32Array;
  fuelMask?: Uint8Array | Uint32Array;
  rawStraw?: Float32Array;
  char?: Float32Array;
  mineralMatter?: Float32Array;
  ash?: Float32Array;
};

export type GpuScalarState = {
  temperature: Float32Array;
  wallTemperature: Float32Array;
  wallInnerTemperature: Float32Array;
  wallOuterTemperature: Float32Array;
  oxygen: Float32Array;
  smoke: Float32Array;
  volatileGas: Float32Array;
  exhaustGas: Float32Array;
  secondaryResidence: Float32Array;
};

export type GpuFuelState = {
  rawStraw: Float32Array;
  char: Float32Array;
  mineralMatter: Float32Array;
  ash: Float32Array;
};

type PingPong = ReturnType<typeof pingPongStorage>;

type GpuBuffer = StorageBuffer | Buffer;

type DestroyableStorageBuffer = GpuBuffer & {
  destroy?: () => void;
  readonly buffer?: { destroy(): void };
};

function destroyStorage(buffer: GpuBuffer): void {
  const resource = buffer as DestroyableStorageBuffer;
  if (typeof resource.destroy === 'function') {
    resource.destroy();
    return;
  }
  resource.buffer?.destroy();
}

/** Device-local Physics v3 fields used by VGPU compute/render passes. */
export class GpuFieldRegistry {
  readonly cellCount: number;
  readonly tracerCount: number;
  readonly solid: StorageBuffer;
  readonly fuelMask: StorageBuffer;
  readonly velocity: PingPong;
  readonly pressure: PingPong;
  readonly divergence: StorageBuffer;
  readonly boundaryFlux: PingPong;

  readonly temperature: PingPong;
  readonly wallInnerTemperature: PingPong;
  readonly wallOuterTemperature: PingPong;
  /** Per-cell xy data: conductivity, inner-face bit mask. */
  readonly wallThermalProperties: StorageBuffer;
  readonly wallMaterial: StorageBuffer;
  readonly oxygen: PingPong;
  readonly smoke: PingPong;
  readonly volatileGas: PingPong;
  readonly exhaustGas: PingPong;
  readonly secondaryResidence: PingPong;
  readonly scalarOutflow: PingPong;
  readonly scalarMassStats: PingPong;

  readonly rawStraw: StorageBuffer;
  readonly char: StorageBuffer;
  readonly mineralMatter: StorageBuffer;
  readonly ash: StorageBuffer;
  readonly renderState: StorageBuffer;
  readonly secondaryReaction: PingPong;
  /** Shared compute/vertex buffer: xy position, z temperature, w reserved. */
  readonly tracers: Buffer;

  constructor(gpu: Gpu, cellCount: number, tracerCount = 320) {
    this.cellCount = cellCount;
    this.tracerCount = tracerCount;
    this.solid = storage(gpu, cellCount * 4, 'read');
    this.fuelMask = storage(gpu, cellCount * 4, 'read');
    this.velocity = pingPongStorage(gpu, cellCount * 8);
    this.pressure = pingPongStorage(gpu, cellCount * 4);
    this.divergence = storage(gpu, cellCount * 4, 'read-write');
    this.boundaryFlux = pingPongStorage(gpu, cellCount * 8);

    this.temperature = pingPongStorage(gpu, cellCount * 4);
    this.wallInnerTemperature = pingPongStorage(gpu, cellCount * 4);
    this.wallOuterTemperature = pingPongStorage(gpu, cellCount * 4);
    this.wallThermalProperties = storage(gpu, cellCount * 8, 'read');
    this.wallMaterial = storage(gpu, cellCount * 4, 'read');
    this.oxygen = pingPongStorage(gpu, cellCount * 4);
    this.smoke = pingPongStorage(gpu, cellCount * 4);
    this.volatileGas = pingPongStorage(gpu, cellCount * 4);
    this.exhaustGas = pingPongStorage(gpu, cellCount * 4);
    this.secondaryResidence = pingPongStorage(gpu, cellCount * 4);
    this.scalarOutflow = pingPongStorage(gpu, cellCount * 16);
    this.scalarMassStats = pingPongStorage(gpu, cellCount * 16);

    this.rawStraw = storage(gpu, cellCount * 4, 'read-write');
    this.char = storage(gpu, cellCount * 4, 'read-write');
    this.mineralMatter = storage(gpu, cellCount * 4, 'read-write');
    this.ash = storage(gpu, cellCount * 4, 'read-write');
    this.renderState = storage(gpu, cellCount * 16, 'read-write');
    this.secondaryReaction = pingPongStorage(gpu, cellCount * 8);
    this.tracers = gpu.device.createBuffer({
      size: tracerCount * 16,
      usage: ['storage', 'vertex', 'copy_dst', 'copy_src'],
      label: 'rocket-stove-airflow:tracers',
    });
    this.tracers.write(new Float32Array(tracerCount * 4).buffer);
  }

  upload(snapshot: CpuAirflowSnapshot): void {
    this.assertLength(snapshot.temperature, 'temperature');
    this.assertLength(snapshot.solid, 'solid');
    this.assertLength(snapshot.u, 'u');
    this.assertLength(snapshot.v, 'v');
    this.assertOptionalLength(snapshot.oxygen, 'oxygen');
    this.assertOptionalLength(snapshot.smoke, 'smoke');
    this.assertOptionalLength(snapshot.volatileGas, 'volatileGas');
    this.assertOptionalLength(snapshot.exhaustGas, 'exhaustGas');
    this.assertOptionalLength(snapshot.secondaryResidence, 'secondaryResidence');
    this.assertOptionalLength(snapshot.wallTemperature, 'wallTemperature');
    this.assertOptionalLength(snapshot.wallInnerTemperature, 'wallInnerTemperature');
    this.assertOptionalLength(snapshot.wallOuterTemperature, 'wallOuterTemperature');
    this.assertOptionalLength(snapshot.wallConductivity, 'wallConductivity');
    this.assertOptionalLength(snapshot.wallMaterial, 'wallMaterial');
    this.assertOptionalLength(snapshot.wallInnerFaceMask, 'wallInnerFaceMask');
    this.assertOptionalLength(snapshot.fuelMask, 'fuelMask');
    this.assertOptionalLength(snapshot.rawStraw, 'rawStraw');
    this.assertOptionalLength(snapshot.char, 'char');
    this.assertOptionalLength(snapshot.mineralMatter, 'mineralMatter');
    this.assertOptionalLength(snapshot.ash, 'ash');

    const solid32 = new Uint32Array(this.cellCount);
    solid32.set(snapshot.solid);
    const fuelMask32 = new Uint32Array(this.cellCount);
    if (snapshot.fuelMask) fuelMask32.set(snapshot.fuelMask);
    const wallMaterial32 = new Uint32Array(this.cellCount);
    if (snapshot.wallMaterial) wallMaterial32.set(snapshot.wallMaterial);
    const wallThermalProperties = new Float32Array(this.cellCount * 2);
    const wallInnerTemperature = snapshot.wallInnerTemperature ?? snapshot.wallTemperature;
    const wallOuterTemperature = snapshot.wallOuterTemperature ?? snapshot.wallTemperature;
    const velocity = new Float32Array(this.cellCount * 2);
    for (let i = 0; i < this.cellCount; i += 1) {
      wallThermalProperties[i * 2] = snapshot.wallConductivity?.[i] ?? 0;
      wallThermalProperties[i * 2 + 1] = snapshot.wallInnerFaceMask?.[i] ?? 0;
      velocity[i * 2] = snapshot.u[i] ?? 0;
      velocity[i * 2 + 1] = snapshot.v[i] ?? 0;
    }

    this.solid.write(solid32.buffer);
    this.fuelMask.write(fuelMask32.buffer);
    this.wallMaterial.write(wallMaterial32.buffer);
    this.wallThermalProperties.write(wallThermalProperties.buffer);
    this.velocity.read.write(velocity.buffer);
    this.velocity.write.write(velocity.buffer);

    this.writeScalarPair(this.temperature, snapshot.temperature, DEFAULT_FUEL_PARAMS.ambientTemperature);
    this.writeScalarPair(this.wallInnerTemperature, wallInnerTemperature, DEFAULT_FUEL_PARAMS.ambientTemperature);
    this.writeScalarPair(this.wallOuterTemperature, wallOuterTemperature, DEFAULT_FUEL_PARAMS.ambientTemperature);
    this.writeScalarPair(this.oxygen, snapshot.oxygen, 1);
    this.writeScalarPair(this.smoke, snapshot.smoke, 0);
    this.writeScalarPair(this.volatileGas, snapshot.volatileGas, 0);
    this.writeScalarPair(this.exhaustGas, snapshot.exhaustGas, 0);
    this.writeScalarPair(this.secondaryResidence, snapshot.secondaryResidence, 0);
    this.writeStorage(this.rawStraw, snapshot.rawStraw, 0);
    this.writeStorage(this.char, snapshot.char, 0);
    this.writeStorage(this.mineralMatter, snapshot.mineralMatter, 0);
    this.writeStorage(this.ash, snapshot.ash, 0);
    this.writeRenderState(snapshot);

    this.resetPressure();
    this.resetBoundaryFlux();
    this.resetScalarOutflow();
    this.resetScalarMassStats();
    this.resetSecondaryReaction();
  }

  uploadTracers(interleavedPositions: Float32Array): void {
    if (interleavedPositions.length !== this.tracerCount * 2) {
      throw new RangeError(
        `tracer position length ${interleavedPositions.length} does not match ${this.tracerCount * 2}`
      );
    }
    const upload = new Float32Array(this.tracerCount * 4);
    for (let i = 0; i < this.tracerCount; i += 1) {
      upload[i * 4] = interleavedPositions[i * 2] ?? 0;
      upload[i * 4 + 1] = interleavedPositions[i * 2 + 1] ?? 0;
    }
    this.tracers.write(upload.buffer);
  }

  resetPressure(): void {
    const zero = new Float32Array(this.cellCount);
    this.pressure.read.write(zero.buffer);
    this.pressure.write.write(zero.buffer);
    this.divergence.write(zero.buffer);
  }

  resetBoundaryFlux(): void {
    const zero = new Float32Array(this.cellCount * 2);
    this.boundaryFlux.read.write(zero.buffer);
    this.boundaryFlux.write.write(zero.buffer);
  }

  resetScalarOutflow(): void {
    const zero = new Float32Array(this.cellCount * 4);
    this.scalarOutflow.read.write(zero.buffer);
    this.scalarOutflow.write.write(zero.buffer);
  }

  resetScalarMassStats(): void {
    const zero = new Float32Array(this.cellCount * 4);
    this.scalarMassStats.read.write(zero.buffer);
    this.scalarMassStats.write.write(zero.buffer);
  }

  resetSecondaryReaction(): void {
    const zero = new Float32Array(this.cellCount * 2);
    this.secondaryReaction.read.write(zero.buffer);
    this.secondaryReaction.write.write(zero.buffer);
  }

  async readVelocity(): Promise<{ u: Float32Array; v: Float32Array }> {
    const interleaved = new Float32Array(await this.velocity.read.read());
    const u = new Float32Array(this.cellCount);
    const v = new Float32Array(this.cellCount);
    for (let i = 0; i < this.cellCount; i += 1) {
      u[i] = interleaved[i * 2] ?? 0;
      v[i] = interleaved[i * 2 + 1] ?? 0;
    }
    return { u, v };
  }

  async readScalarState(): Promise<GpuScalarState> {
    const [temperature, wallInnerTemperature, wallOuterTemperature, oxygen, smoke, volatileGas, exhaustGas, secondaryResidence] = await Promise.all([
      this.temperature.read.read(),
      this.wallInnerTemperature.read.read(),
      this.wallOuterTemperature.read.read(),
      this.oxygen.read.read(),
      this.smoke.read.read(),
      this.volatileGas.read.read(),
      this.exhaustGas.read.read(),
      this.secondaryResidence.read.read(),
    ]);
    const inner = new Float32Array(wallInnerTemperature);
    const outer = new Float32Array(wallOuterTemperature);
    const average = new Float32Array(this.cellCount);
    for (let i = 0; i < this.cellCount; i += 1) {
      average[i] = (inner[i] + outer[i]) * 0.5;
    }
    return {
      temperature: new Float32Array(temperature),
      wallTemperature: average,
      wallInnerTemperature: inner,
      wallOuterTemperature: outer,
      oxygen: new Float32Array(oxygen),
      smoke: new Float32Array(smoke),
      volatileGas: new Float32Array(volatileGas),
      exhaustGas: new Float32Array(exhaustGas),
      secondaryResidence: new Float32Array(secondaryResidence),
    };
  }

  async readFuelState(): Promise<GpuFuelState> {
    const [rawStraw, charMass, mineralMatter, ash] = await Promise.all([
      this.rawStraw.read(),
      this.char.read(),
      this.mineralMatter.read(),
      this.ash.read(),
    ]);
    return {
      rawStraw: new Float32Array(rawStraw),
      char: new Float32Array(charMass),
      mineralMatter: new Float32Array(mineralMatter),
      ash: new Float32Array(ash),
    };
  }

  async readTracers(): Promise<Float32Array> {
    const packed = new Float32Array(await this.tracers.read(this.tracerCount * 16));
    const positions = new Float32Array(this.tracerCount * 2);
    for (let i = 0; i < this.tracerCount; i += 1) {
      positions[i * 2] = packed[i * 4] ?? 0;
      positions[i * 2 + 1] = packed[i * 4 + 1] ?? 0;
    }
    return positions;
  }

  async readPressure(): Promise<Float32Array> {
    return new Float32Array(await this.pressure.read.read());
  }

  async readDivergence(): Promise<Float32Array> {
    return new Float32Array(await this.divergence.read());
  }

  async readBoundaryFluxTotal(): Promise<{ netOutward: number; faceCount: number }> {
    const values = new Float32Array(await this.boundaryFlux.read.read());
    return { netOutward: values[0] ?? 0, faceCount: values[1] ?? 0 };
  }

  async readScalarOutflowTotal(): Promise<{ smokeOut: number; volatileOut: number; exhaustOut: number }> {
    const values = new Float32Array(await this.scalarOutflow.read.read());
    return {
      smokeOut: values[0] ?? 0,
      volatileOut: values[1] ?? 0,
      exhaustOut: values[2] ?? 0,
    };
  }

  async readSecondaryReactionTotal(): Promise<number> {
    const values = new Float32Array(await this.secondaryReaction.read.read());
    return values[0] ?? 0;
  }

  resetVelocity(): void {
    const zero = new Float32Array(this.cellCount * 2);
    this.velocity.read.write(zero.buffer);
    this.velocity.write.write(zero.buffer);
  }

  dispose(): void {
    destroyStorage(this.solid);
    destroyStorage(this.fuelMask);
    this.destroyPair(this.velocity);
    this.destroyPair(this.pressure);
    destroyStorage(this.divergence);
    this.destroyPair(this.boundaryFlux);
    this.destroyPair(this.temperature);
    this.destroyPair(this.wallInnerTemperature);
    this.destroyPair(this.wallOuterTemperature);
    destroyStorage(this.wallThermalProperties);
    destroyStorage(this.wallMaterial);
    this.destroyPair(this.oxygen);
    this.destroyPair(this.smoke);
    this.destroyPair(this.volatileGas);
    this.destroyPair(this.exhaustGas);
    this.destroyPair(this.secondaryResidence);
    this.destroyPair(this.scalarOutflow);
    this.destroyPair(this.scalarMassStats);
    destroyStorage(this.rawStraw);
    destroyStorage(this.char);
    destroyStorage(this.mineralMatter);
    destroyStorage(this.ash);
    destroyStorage(this.renderState);
    this.destroyPair(this.secondaryReaction);
    destroyStorage(this.tracers);
  }

  private writeScalarPair(pair: PingPong, source: Float32Array | undefined, fallback: number): void {
    const data = new Float32Array(this.cellCount);
    if (source) data.set(source);
    else data.fill(fallback);
    pair.read.write(data.buffer);
    pair.write.write(data.buffer);
  }

  private writeStorage(buffer: StorageBuffer, source: Float32Array | undefined, fallback: number): void {
    const data = new Float32Array(this.cellCount);
    if (source) data.set(source);
    else data.fill(fallback);
    buffer.write(data.buffer);
  }

  private writeRenderState(snapshot: CpuAirflowSnapshot): void {
    const data = new Float32Array(this.cellCount * 4);
    for (let i = 0; i < this.cellCount; i += 1) {
      const offset = i * 4;
      const innerTemperature = snapshot.wallInnerTemperature?.[i]
        ?? snapshot.wallTemperature?.[i]
        ?? DEFAULT_FUEL_PARAMS.ambientTemperature;
      const outerTemperature = snapshot.wallOuterTemperature?.[i]
        ?? snapshot.wallTemperature?.[i]
        ?? DEFAULT_FUEL_PARAMS.ambientTemperature;
      data[offset] = snapshot.solid[i]
        ? (innerTemperature + outerTemperature) * 0.5
        : snapshot.temperature[i] ?? DEFAULT_FUEL_PARAMS.ambientTemperature;
      data[offset + 1] = snapshot.smoke?.[i] ?? 0;
      data[offset + 2] = snapshot.rawStraw?.[i] ?? 0;
      data[offset + 3] = snapshot.char?.[i] ?? 0;
    }
    this.renderState.write(data.buffer);
  }

  private destroyPair(pair: PingPong): void {
    destroyStorage(pair.read);
    destroyStorage(pair.write);
  }

  private assertLength(value: ArrayLike<number>, name: string): void {
    if (value.length !== this.cellCount) {
      throw new RangeError(`${name} length ${value.length} does not match cellCount ${this.cellCount}`);
    }
  }

  private assertOptionalLength(value: ArrayLike<number> | undefined, name: string): void {
    if (value) this.assertLength(value, name);
  }
}
