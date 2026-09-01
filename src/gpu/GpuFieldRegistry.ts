import { pingPongStorage, storage, type Gpu, type StorageBuffer } from 'vgpu';

export type CpuAirflowSnapshot = {
  temperature: Float32Array;
  solid: Uint8Array | Uint32Array;
  u: Float32Array;
  v: Float32Array;
};

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

  constructor(gpu: Gpu, cellCount: number) {
    this.cellCount = cellCount;
    this.temperature = storage(gpu, cellCount * 4, 'read');
    this.solid = storage(gpu, cellCount * 4, 'read');
    this.velocity = pingPongStorage(gpu, cellCount * 8);
    this.pressure = pingPongStorage(gpu, cellCount * 4);
    this.divergence = storage(gpu, cellCount * 4, 'read-write');
  }

  upload(snapshot: CpuAirflowSnapshot): void {
    this.assertLength(snapshot.temperature, 'temperature');
    this.assertLength(snapshot.solid, 'solid');
    this.assertLength(snapshot.u, 'u');
    this.assertLength(snapshot.v, 'v');

    const solid32 = snapshot.solid instanceof Uint32Array
      ? snapshot.solid
      : Uint32Array.from(snapshot.solid);
    const velocity = new Float32Array(this.cellCount * 2);
    for (let i = 0; i < this.cellCount; i += 1) {
      velocity[i * 2] = snapshot.u[i];
      velocity[i * 2 + 1] = snapshot.v[i];
    }

    this.temperature.write(snapshot.temperature);
    this.solid.write(solid32);
    this.velocity.read.write(velocity);
    this.velocity.write.write(velocity);
    this.resetPressure();
  }

  resetPressure(): void {
    const zero = new Float32Array(this.cellCount);
    this.pressure.read.write(zero);
    this.pressure.write.write(zero);
    this.divergence.write(zero);
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

  resetVelocity(): void {
    const zero = new Float32Array(this.cellCount * 2);
    this.velocity.read.write(zero);
    this.velocity.write.write(zero);
  }

  dispose(): void {
    this.temperature.destroy();
    this.solid.destroy();
    this.velocity.read.destroy();
    this.velocity.write.destroy();
    this.pressure.read.destroy();
    this.pressure.write.destroy();
    this.divergence.destroy();
  }

  private assertLength(value: ArrayLike<number>, name: string): void {
    if (value.length !== this.cellCount) {
      throw new RangeError(`${name} length ${value.length} does not match cellCount ${this.cellCount}`);
    }
  }
}
