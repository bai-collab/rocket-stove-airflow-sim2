/**
 * Phase-3 skeleton only.
 * Physics v3 must be validated on the CPU reference model before these passes
 * become authoritative.
 */
export interface SimulationBackend {
  initialize(): Promise<void> | void;
  reset(): void;
  step(dt: number): void;
  dispose(): void;
}

export class GpuSimulationBackend implements SimulationBackend {
  async initialize(): Promise<void> {
    throw new Error('VGPU backend scaffold only: implement after CPU Physics v3 oracle is frozen.');
  }
  reset(): void {}
  step(_dt: number): void {}
  dispose(): void {}
}
