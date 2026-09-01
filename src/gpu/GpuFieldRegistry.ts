import { pingPongStorage, storage, type Gpu, type StorageBuffer } from 'vgpu';

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
};

export type GpuScalarState = {
  temperature: Float32Array;
  oxygen: Float32Array;
  smoke: Float32Array;
  volatileGas: Float32Array;
  exhaustGas: Float32Array;
  secondaryResidence: Float32Array;
};

type PingPong = ReturnType<typeof pingPongStorage>;

type DestroyableStorageBuffer = StorageBuffer & {
  destroy?: () => void;
  readonly buffer?: { destroy(): void };
};

function destroyStorage(buffer: StorageBuffer): void {
  const resource = buffer as DestroyableStorageBuffer;
  if (typeof resource.destroy === 'function') {
    resource.destroy();
    return;
  }
  resource.buffer?.destroy();
}

/**
 * Device-local field ownership for the VGPU airflow + scalar migration passes.
 * CPU Physics v3 remains the oracle until browser state ownership switches.
 */
export class GpuFieldRegistry {
  readonly cellCount: number;
  readonly solid: StorageBuffer;
  readonly velocity: PingPong;
  readonly pressure: PingPong;
  readonly divergence: StorageBuffer;
  readonly boundaryFlux: PingPong;

  readonly temperature: PingPong;
  readonly oxygen: PingPong;
  readonly smoke: PingPong;
  readonly volatileGas: PingPong;
  readonly exhaustGas: PingPong;
  readonly secondaryResidence: PingPong;
  readonly scalarOutflow: PingPong;

  constructor(gpu: Gpu, cellCount: number) {
    this.cellCount = cellCount;
    this.solid = storage(gpu, cellCount * 4, 'read');
    this.velocity = pingPongStorage(gpu, cellCount * 8);
    this.pressure = pingPongStorage(gpu, cellCount * 4);
    this.divergence = storage(gpu, cellCount * 4, 'read-write');
    this.boundaryFlux = pingPongStorage(gpu, cellCount * 8);

    this.temperature = pingPongStorage(gpu, cellCount * 4);
    this.oxygen = pingPongStorage(gpu, cellCount * 4);
    this.smoke = pingPongStorage(gpu, cellCount * 4);
    this.volatileGas = pingPongStorage(gpu, cellCount * 4);
    this.exhaustGas = pingPongStorage(gpu, cellCount * 4);
    this.secondaryResidence = pingPongStorage(gpu, cellCount * 4);
    this.scalarOutflow = pingPongStorage(gpu, cellCount * 8);
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

    const solid32 = new Uint32Array(this.cellCount);
    solid32.set(snapshot.solid);
    const velocity = new Float32Array(this.cellCount * 2);
    for (let i = 0; i < this.cellCount; i += 1) {
      velocity[i * 2] = snapshot.u[i] ?? 0;
      velocity[i * 2 + 1] = snapshot.v[i] ?? 0;
    }

    this.solid.write(solid32.buffer);
    this.velocity.read.write(velocity.buffer);
    this.velocity.write.write(velocity.buffer);

    this.writeScalarPair(this.temperature, snapshot.temperature, 25);
    this.writeScalarPair(this.oxygen, snapshot.oxygen, 1);
    this.writeScalarPair(this.smoke, snapshot.smoke, 0);
    this.writeScalarPair(this.volatileGas, snapshot.volatileGas, 0);
    this.writeScalarPair(this.exhaustGas, snapshot.exhaustGas, 0);
    this.writeScalarPair(this.secondaryResidence, snapshot.secondaryResidence, 0);

    this.resetPressure();
    this.resetBoundaryFlux();
    this.resetScalarOutflow();
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
    const zero = new Float32Array(this.cellCount * 2);
    this.scalarOutflow.read.write(zero.buffer);
    this.scalarOutflow.write.write(zero.buffer);
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
    const [temperature, oxygen, smoke, volatileGas, exhaustGas, secondaryResidence] = await Promise.all([
      this.temperature.read.read(),
      this.oxygen.read.read(),
      this.smoke.read.read(),
      this.volatileGas.read.read(),
      this.exhaustGas.read.read(),
      this.secondaryResidence.read.read(),
    ]);
    return {
      temperature: new Float32Array(temperature),
      oxygen: new Float32Array(oxygen),
      smoke: new Float32Array(smoke),
      volatileGas: new Float32Array(volatileGas),
      exhaustGas: new Float32Array(exhaustGas),
      secondaryResidence: new Float32Array(secondaryResidence),
    };
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

  async readScalarOutflowTotal(): Promise<{ smokeOut: number; volatileOut: number }> {
    const values = new Float32Array(await this.scalarOutflow.read.read());
    return { smokeOut: values[0] ?? 0, volatileOut: values[1] ?? 0 };
  }

  resetVelocity(): void {
    const zero = new Float32Array(this.cellCount * 2);
    this.velocity.read.write(zero.buffer);
    this.velocity.write.write(zero.buffer);
  }

  dispose(): void {
    destroyStorage(this.solid);
    this.destroyPair(this.velocity);
    this.destroyPair(this.pressure);
    destroyStorage(this.divergence);
    this.destroyPair(this.boundaryFlux);
    this.destroyPair(this.temperature);
    this.destroyPair(this.oxygen);
    this.destroyPair(this.smoke);
    this.destroyPair(this.volatileGas);
    this.destroyPair(this.exhaustGas);
    this.destroyPair(this.secondaryResidence);
    this.destroyPair(this.scalarOutflow);
  }

  private writeScalarPair(pair: PingPong, source: Float32Array | undefined, fallback: number): void {
    const data = new Float32Array(this.cellCount);
    if (source) data.set(source);
    else data.fill(fallback);
    pair.read.write(data.buffer);
    pair.write.write(data.buffer);
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
