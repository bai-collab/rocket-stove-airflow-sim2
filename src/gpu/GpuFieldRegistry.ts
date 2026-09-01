import { pingPongStorage, storage, type Gpu, type StorageBuffer } from 'vgpu';

export type CpuAirflowSnapshot = {
  temperature: Float32Array;
  solid: Uint8Array | Uint32Array;
  u: Float32Array;
  v: Float32Array;
};

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
 * Device-local field ownership for the VGPU airflow migration passes.
 * CPU state remains authoritative until whole-pipeline parity is stable.
 */
export class GpuFieldRegistry {
  readonly cellCount: number;
  readonly temperature: StorageBuffer;
  readonly solid: StorageBuffer;
  readonly velocity: ReturnType<typeof pingPongStorage>;
  readonly pressure: ReturnType<typeof pingPongStorage>;
  readonly divergence: StorageBuffer;
  readonly boundaryFlux: ReturnType<typeof pingPongStorage>;

  constructor(gpu: Gpu, cellCount: number) {
    this.cellCount = cellCount;
    this.temperature = storage(gpu, cellCount * 4, 'read');
    this.solid = storage(gpu, cellCount * 4, 'read');
    this.velocity = pingPongStorage(gpu, cellCount * 8);
    this.pressure = pingPongStorage(gpu, cellCount * 4);
    this.divergence = storage(gpu, cellCount * 4, 'read-write');
    this.boundaryFlux = pingPongStorage(gpu, cellCount * 8);
  }

  upload(snapshot: CpuAirflowSnapshot): void {
    this.assertLength(snapshot.temperature, 'temperature');
    this.assertLength(snapshot.solid, 'solid');
    this.assertLength(snapshot.u, 'u');
    this.assertLength(snapshot.v, 'v');

    // Copy into owned ArrayBuffers before VGPU.write(). This avoids passing a
    // SharedArrayBuffer-capable ArrayBufferLike view across the WebGPU API.
    const temperature = new Float32Array(this.cellCount);
    temperature.set(snapshot.temperature);
    const solid32 = new Uint32Array(this.cellCount);
    solid32.set(snapshot.solid);
    const velocity = new Float32Array(this.cellCount * 2);
    for (let i = 0; i < this.cellCount; i += 1) {
      velocity[i * 2] = snapshot.u[i];
      velocity[i * 2 + 1] = snapshot.v[i];
    }

    this.temperature.write(temperature.buffer);
    this.solid.write(solid32.buffer);
    this.velocity.read.write(velocity.buffer);
    this.velocity.write.write(velocity.buffer);
    this.resetPressure();
    this.resetBoundaryFlux();
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

  async readVelocity(): Promise<{ u: Float32Array; v: Float32Array }> {
    const interleaved = new Float32Array(await this.velocity.read.read());
    const u = new Float32Array(this.cellCount);
    const v = new Float32Array(this.cellCount);
    for (let i = 0; i < this.cellCount; i += 1) {
      u[i] = interleaved[i * 2];
      v[i] = interleaved[i * 2 + 1];
    }
    return { u, v };
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

  resetVelocity(): void {
    const zero = new Float32Array(this.cellCount * 2);
    this.velocity.read.write(zero.buffer);
    this.velocity.write.write(zero.buffer);
  }

  dispose(): void {
    destroyStorage(this.temperature);
    destroyStorage(this.solid);
    destroyStorage(this.velocity.read);
    destroyStorage(this.velocity.write);
    destroyStorage(this.pressure.read);
    destroyStorage(this.pressure.write);
    destroyStorage(this.divergence);
    destroyStorage(this.boundaryFlux.read);
    destroyStorage(this.boundaryFlux.write);
  }

  private assertLength(value: ArrayLike<number>, name: string): void {
    if (value.length !== this.cellCount) {
      throw new RangeError(`${name} length ${value.length} does not match cellCount ${this.cellCount}`);
    }
  }
}
