import { BUILD_CELL, STOVE_PRESETS } from './presets.mjs';
import {
  DEFAULT_FUEL_PARAMS,
  createFuelState,
  getFuelPhase,
  stepPrimaryFuelModel,
  stepSecondarySmokeOxidation,
} from '../physics/fuel-model.mjs';
import {
  DEFAULT_WALL_MATERIAL_ID,
  WALL_FACE_BITS,
  WALL_CONDUCTION_PARAMS,
  getWallMaterial,
  normalizeWallMaterialId,
  radiativeHeatFlux,
  radiativeHeatTransfer,
} from '../physics/wall-materials.mjs';

export const SIM_WIDTH = 900;
export const SIM_HEIGHT = 560;
export const H = 12;
export const NX = Math.ceil(SIM_WIDTH / H);
export const NY = Math.ceil(SIM_HEIGHT / H);
export const N = NX * NY;
export const DT = 1 / 30;
export const AMBIENT_T = DEFAULT_FUEL_PARAMS.ambientTemperature;
export const AMBIENT_O2 = 1;
export const MAX_T = DEFAULT_FUEL_PARAMS.maxTemperature;
export const MAX_SPEED = 180;

const PRESSURE_ITERS = 36;
const TRACE_STEP = Math.max(2, H * 0.35);
const DEFAULT_TRACERS = 320;
const WALL_FACE_DIRECTIONS = Object.freeze([
  Object.freeze({ dx: -1, dy: 0, bit: WALL_FACE_BITS.left }),
  Object.freeze({ dx: 1, dy: 0, bit: WALL_FACE_BITS.right }),
  Object.freeze({ dx: 0, dy: -1, bit: WALL_FACE_BITS.up }),
  Object.freeze({ dx: 0, dy: 1, bit: WALL_FACE_BITS.down }),
]);

const FUEL = DEFAULT_FUEL_PARAMS;
const GRID_EPSILON = 1e-5;

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smoothstep = (x) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};
const idx = (x, y) => y * NX + x;
const gridX = (px) => clamp(Math.floor(px / H + GRID_EPSILON), 0, NX - 1);
const gridY = (py) => clamp(Math.floor(py / H + GRID_EPSILON), 0, NY - 1);
const inCanvas = (x, y) => x >= 0 && y >= 0 && x < SIM_WIDTH && y < SIM_HEIGHT;
const snap = (v) => Math.floor(v / BUILD_CELL) * BUILD_CELL;

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export class CpuRocketSimulation {
  constructor() {
    this.u = new Float32Array(N);
    this.v = new Float32Array(N);
    this.uPrev = new Float32Array(N);
    this.vPrev = new Float32Array(N);
    this.pressure = new Float32Array(N);
    this.pressureNext = new Float32Array(N);
    this.divergence = new Float32Array(N);
    this.temperature = new Float32Array(N);
    this.temperaturePrev = new Float32Array(N);
    this.oxygen = new Float32Array(N);
    this.oxygenPrev = new Float32Array(N);
    this.smoke = new Float32Array(N);
    this.smokePrev = new Float32Array(N);
    this.volatileGas = new Float32Array(N);
    this.volatilePrev = new Float32Array(N);
    this.exhaustGas = new Float32Array(N);
    this.exhaustPrev = new Float32Array(N);
    this.secondaryResidence = new Float32Array(N);
    this.secondaryResidencePrev = new Float32Array(N);
    this.rawStraw = new Float32Array(N);
    this.char = new Float32Array(N);
    this.mineralMatter = new Float32Array(N);
    this.ash = new Float32Array(N);
    this.wallTemperature = new Float32Array(N);
    this.wallTemperaturePrev = new Float32Array(N);
    this.wallInnerTemperature = new Float32Array(N);
    this.wallInnerTemperaturePrev = new Float32Array(N);
    this.wallOuterTemperature = new Float32Array(N);
    this.wallOuterTemperaturePrev = new Float32Array(N);
    this.wallConductivity = new Float32Array(N);
    this.wallMaterial = new Uint8Array(N);
    this.wallInnerFaceMask = new Uint8Array(N);
    this.wallInnerDelta = new Float32Array(N);
    this.wallOuterDelta = new Float32Array(N);
    this.fluidThermalDelta = new Float32Array(N);
    this.solid = new Uint8Array(N);
    this.fuelMask = new Uint8Array(N);
    this.fuelInitialOrganic = new Float32Array(N);
    this.fuelInitialMineral = new Float32Array(N);
    this.fuelWork = createFuelState();

    this.walls = [];
    this.fuels = [];
    this.tracers = [];
    this.running = false;
    this.ignited = false;
    this.time = 0;
    this.ignitionRemaining = 0;
    this.initialOrganic = 0;
    this.initialMineral = 0;
    this.pyrolyzedTotal = 0;
    this.charGeneratedTotal = 0;
    this.charBurnedTotal = 0;
    this.volatileGeneratedTotal = 0;
    this.volatileBurnedTotal = 0;
    this.smokeGeneratedTotal = 0;
    this.smokeOxidizedTotal = 0;
    this.exhaustTotal = 0;
    this.smokeOutTotal = 0;
    this.volatileOutTotal = 0;
    this.exhaustOutTotal = 0;
    this.lastSecondaryRate = 0;
    this.lastPressureResidual = 0;
    this.lastInflow = 0;
    this.lastOutflow = 0;

    this.resetFields();
    this.loadPreset('straight');
  }

  resetFields() {
    this.u.fill(0); this.v.fill(0); this.uPrev.fill(0); this.vPrev.fill(0);
    this.pressure.fill(0); this.pressureNext.fill(0); this.divergence.fill(0);
    this.temperature.fill(AMBIENT_T); this.temperaturePrev.fill(AMBIENT_T);
    this.oxygen.fill(AMBIENT_O2); this.oxygenPrev.fill(AMBIENT_O2);
    this.smoke.fill(0); this.smokePrev.fill(0);
    this.volatileGas.fill(0); this.volatilePrev.fill(0);
    this.exhaustGas.fill(0); this.exhaustPrev.fill(0);
    this.secondaryResidence.fill(0); this.secondaryResidencePrev.fill(0);
    this.rawStraw.fill(0); this.char.fill(0); this.mineralMatter.fill(0); this.ash.fill(0);
    this.wallTemperature.fill(AMBIENT_T); this.wallTemperaturePrev.fill(AMBIENT_T);
    this.wallInnerTemperature.fill(AMBIENT_T); this.wallInnerTemperaturePrev.fill(AMBIENT_T);
    this.wallOuterTemperature.fill(AMBIENT_T); this.wallOuterTemperaturePrev.fill(AMBIENT_T);
    this.wallConductivity.fill(0); this.wallMaterial.fill(0); this.wallInnerFaceMask.fill(0);
    this.wallInnerDelta.fill(0); this.wallOuterDelta.fill(0); this.fluidThermalDelta.fill(0);
    this.solid.fill(0); this.fuelMask.fill(0);
    this.fuelInitialOrganic.fill(0); this.fuelInitialMineral.fill(0);
    this.time = 0;
    this.running = false;
    this.ignited = false;
    this.ignitionRemaining = 0;
    this.initialOrganic = 0;
    this.initialMineral = 0;
    this.pyrolyzedTotal = 0;
    this.charGeneratedTotal = 0;
    this.charBurnedTotal = 0;
    this.volatileGeneratedTotal = 0;
    this.volatileBurnedTotal = 0;
    this.smokeGeneratedTotal = 0;
    this.smokeOxidizedTotal = 0;
    this.exhaustTotal = 0;
    this.smokeOutTotal = 0;
    this.volatileOutTotal = 0;
    this.exhaustOutTotal = 0;
    this.lastSecondaryRate = 0;
    this.lastPressureResidual = 0;
    this.lastInflow = 0;
    this.lastOutflow = 0;
  }

  clearScene() {
    this.walls = [];
    this.fuels = [];
    this.resetFields();
    this.seedTracers();
  }

  loadPreset(id) {
    const preset = STOVE_PRESETS[id];
    if (!preset) return false;
    this.walls = preset.walls.map((p) => ({
      ...p,
      materialId: normalizeWallMaterialId(p.materialId ?? DEFAULT_WALL_MATERIAL_ID),
    }));
    this.fuels = preset.fuels.map((p) => ({ ...p }));
    this.resetFields();
    this.rebuildGeometry(true);
    this.seedTracers();
    return true;
  }

  ignite() {
    if (!this.fuels.length) return;
    this.ignited = true;
    this.running = true;
    this.ignitionRemaining = Math.max(this.ignitionRemaining, 2.6);
  }

  pause() {
    this.running = !this.running;
  }

  setToolAt(tool, px, py, wallMaterialId = DEFAULT_WALL_MATERIAL_ID) {
    const x = snap(px);
    const y = snap(py);
    if (x < 0 || y < 0 || x >= SIM_WIDTH || y >= SIM_HEIGHT) return;
    const same = (p) => p.x === x && p.y === y;

    if (tool === 'wall') {
      if (this.fuels.some(same)) return;
      const materialId = normalizeWallMaterialId(wallMaterialId);
      const existing = this.walls.find(same);
      if (existing) existing.materialId = materialId;
      else this.walls.push({ x, y, materialId });
    } else if (tool === 'fuel') {
      if (!this.fuels.some(same) && !this.walls.some(same)) this.fuels.push({ x, y });
    } else if (tool === 'erase') {
      this.walls = this.walls.filter((p) => !same(p));
      this.fuels = this.fuels.filter((p) => !same(p));
    }

    this.rebuildGeometry(false);
  }

  rebuildGeometry(resetFuel) {
    const previousRaw = resetFuel ? null : this.rawStraw.slice();
    const previousChar = resetFuel ? null : this.char.slice();
    const previousMineral = resetFuel ? null : this.mineralMatter.slice();
    const previousAsh = resetFuel ? null : this.ash.slice();
    const previousFuelMask = resetFuel ? null : this.fuelMask.slice();
    const previousFuelInitialOrganic = resetFuel ? null : this.fuelInitialOrganic.slice();
    const previousFuelInitialMineral = resetFuel ? null : this.fuelInitialMineral.slice();
    const previousSolid = resetFuel ? null : this.solid.slice();

    this.solid.fill(0);
    this.fuelMask.fill(0);
    this.wallMaterial.fill(0);
    this.wallConductivity.fill(0);
    this.wallInnerFaceMask.fill(0);

    for (const wall of this.walls) {
      const material = getWallMaterial(wall.materialId);
      const x0 = Math.floor(wall.x / H);
      const y0 = Math.floor(wall.y / H);
      const x1 = Math.min(NX, Math.ceil((wall.x + BUILD_CELL) / H));
      const y1 = Math.min(NY, Math.ceil((wall.y + BUILD_CELL) / H));
      for (let gy = y0; gy < y1; gy += 1) {
        for (let gx = x0; gx < x1; gx += 1) {
          const i = idx(gx, gy);
          this.solid[i] = 1;
          this.wallMaterial[i] = material.numericId;
          this.wallConductivity[i] = material.conductivity;
        }
      }
    }

    const resetCell = (i, solid) => {
      this.u[i] = 0; this.v[i] = 0; this.uPrev[i] = 0; this.vPrev[i] = 0;
      this.pressure[i] = 0; this.pressureNext[i] = 0; this.divergence[i] = 0;
      this.temperature[i] = AMBIENT_T;
      this.temperaturePrev[i] = AMBIENT_T;
      this.oxygen[i] = solid ? 0 : AMBIENT_O2;
      this.oxygenPrev[i] = solid ? 0 : AMBIENT_O2;
      this.wallTemperature[i] = AMBIENT_T;
      this.wallTemperaturePrev[i] = AMBIENT_T;
      this.wallInnerTemperature[i] = AMBIENT_T;
      this.wallInnerTemperaturePrev[i] = AMBIENT_T;
      this.wallOuterTemperature[i] = AMBIENT_T;
      this.wallOuterTemperaturePrev[i] = AMBIENT_T;
      this.smoke[i] = 0; this.smokePrev[i] = 0;
      this.volatileGas[i] = 0; this.volatilePrev[i] = 0;
      this.exhaustGas[i] = 0; this.exhaustPrev[i] = 0;
      this.secondaryResidence[i] = 0; this.secondaryResidencePrev[i] = 0;
    };

    for (let i = 0; i < N; i += 1) {
      if (this.solid[i] || previousSolid?.[i]) resetCell(i, this.solid[i] === 1);
    }

    this.rawStraw.fill(0);
    this.char.fill(0);
    this.mineralMatter.fill(0);
    this.ash.fill(0);
    this.fuelInitialOrganic.fill(0);
    this.fuelInitialMineral.fill(0);

    for (const fuel of this.fuels) {
      const x0 = Math.floor(fuel.x / H);
      const y0 = Math.floor(fuel.y / H);
      const cells = [];
      for (let gy = y0; gy < Math.min(NY, y0 + BUILD_CELL / H); gy += 1) {
        for (let gx = x0; gx < Math.min(NX, x0 + BUILD_CELL / H); gx += 1) {
          const i = idx(gx, gy);
          if (!this.solid[i]) cells.push(i);
        }
      }
      const organicPerCell = cells.length ? 1 / cells.length : 0;
      const mineralPerCell = cells.length ? 0.12 / cells.length : 0;
      for (const i of cells) {
        this.fuelMask[i] = 1;
        if (previousFuelMask?.[i]) {
          this.rawStraw[i] = previousRaw[i];
          this.char[i] = previousChar[i];
          this.mineralMatter[i] = previousMineral[i];
          this.ash[i] = previousAsh[i];
          this.fuelInitialOrganic[i] = previousFuelInitialOrganic[i];
          this.fuelInitialMineral[i] = previousFuelInitialMineral[i];
        } else {
          this.rawStraw[i] = organicPerCell;
          this.mineralMatter[i] = mineralPerCell;
          this.fuelInitialOrganic[i] = organicPerCell;
          this.fuelInitialMineral[i] = mineralPerCell;
        }
      }
    }

    this.buildWallInnerFaceMask();
    this.initialOrganic = this.sum(this.fuelInitialOrganic);
    this.initialMineral = this.sum(this.fuelInitialMineral);

    this.relocateTracersOutOfSolids();
  }

  buildWallInnerFaceMask() {
    const distance = new Int32Array(N);
    distance.fill(-1);
    const queue = new Int32Array(N);
    let head = 0;
    let tail = 0;

    for (let i = 0; i < N; i += 1) {
      if (this.fuelMask[i] && !this.solid[i]) {
        distance[i] = 0;
        queue[tail] = i;
        tail += 1;
      }
    }

    while (head < tail) {
      const current = queue[head];
      head += 1;
      const x = current % NX;
      const y = Math.floor(current / NX);
      const nextDistance = distance[current] + 1;
      for (const { dx, dy } of WALL_FACE_DIRECTIONS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= NX || ny >= NY) continue;
        const neighbour = idx(nx, ny);
        if (this.solid[neighbour] || distance[neighbour] >= 0) continue;
        distance[neighbour] = nextDistance;
        queue[tail] = neighbour;
        tail += 1;
      }
    }

    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const i = idx(x, y);
        if (!this.solid[i]) continue;

        let closest = Infinity;
        for (const { dx, dy } of WALL_FACE_DIRECTIONS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= NX || ny >= NY) continue;
          const neighbour = idx(nx, ny);
          if (this.solid[neighbour] || distance[neighbour] < 0) continue;
          closest = Math.min(closest, distance[neighbour]);
        }
        if (!Number.isFinite(closest)) continue;

        let mask = 0;
        for (const { dx, dy, bit } of WALL_FACE_DIRECTIONS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= NX || ny >= NY) continue;
          const neighbour = idx(nx, ny);
          if (!this.solid[neighbour] && distance[neighbour] === closest) mask |= bit;
        }
        this.wallInnerFaceMask[i] = mask;
      }
    }
  }

  step(dt = DT) {
    if (!this.running) return;
    this.time += dt;
    this.applyFuelTransformation(dt);
    this.addBuoyancy(dt);

    this.uPrev.set(this.u);
    this.vPrev.set(this.v);
    this.advectField(this.u, this.uPrev, this.uPrev, this.vPrev, dt, 0, false);
    this.advectField(this.v, this.vPrev, this.uPrev, this.vPrev, dt, 0, false);
    this.projectVelocity();

    this.temperaturePrev.set(this.temperature);
    this.oxygenPrev.set(this.oxygen);
    this.smokePrev.set(this.smoke);
    this.volatilePrev.set(this.volatileGas);
    this.exhaustPrev.set(this.exhaustGas);
    this.secondaryResidencePrev.set(this.secondaryResidence);

    this.advectField(this.temperature, this.temperaturePrev, this.u, this.v, dt, AMBIENT_T, true);
    this.advectField(this.oxygen, this.oxygenPrev, this.u, this.v, dt, AMBIENT_O2, true);
    this.advectField(this.smoke, this.smokePrev, this.u, this.v, dt, 0, true, true);
    this.advectField(this.volatileGas, this.volatilePrev, this.u, this.v, dt, 0, true, true);
    this.advectField(this.exhaustGas, this.exhaustPrev, this.u, this.v, dt, 0, true, true);
    this.advectField(this.secondaryResidence, this.secondaryResidencePrev, this.u, this.v, dt, 0, true);

    this.applyWallThermalExchange(dt);
    this.coolAndMix(dt);
    this.updateSecondaryResidence(dt);
    this.applySecondaryCombustion(dt);
    this.applyOpenBoundaryExchange(dt);
    this.updateTracers(dt);
  }

  applyFuelTransformation(dt) {
    const ignitionActive = this.ignitionRemaining > 0;
    if (ignitionActive) {
      this.ignitionRemaining = Math.max(0, this.ignitionRemaining - dt);
    }

    const state = this.fuelWork;
    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const i = idx(x, y);
        if (!this.fuelMask[i] || this.solid[i]) continue;

        state.rawStraw = this.rawStraw[i];
        state.char = this.char[i];
        state.mineralMatter = this.mineralMatter[i];
        state.ash = this.ash[i];
        state.volatileGas = this.volatileGas[i];
        state.smoke = this.smoke[i];
        state.exhaustGas = this.exhaustGas[i];
        const previousExhaust = state.exhaustGas;
        state.oxygen = this.oxygen[i];
        state.temperature = this.temperature[i];
        state.pyrolyzedTotal = 0;
        state.charGeneratedTotal = 0;
        state.charBurnedTotal = 0;
        state.volatileGeneratedTotal = 0;
        state.volatileBurnedTotal = 0;
        state.smokeGeneratedTotal = 0;
        state.smokeOxidizedTotal = 0;

        stepPrimaryFuelModel(
          state,
          dt,
          { ignitionActive, mixing: this.localMixing(x, y, i) },
          FUEL,
        );

        this.rawStraw[i] = state.rawStraw;
        this.char[i] = state.char;
        this.mineralMatter[i] = state.mineralMatter;
        this.ash[i] = state.ash;
        this.volatileGas[i] = state.volatileGas;
        this.smoke[i] = state.smoke;
        this.exhaustGas[i] = state.exhaustGas;
        this.oxygen[i] = state.oxygen;
        this.temperature[i] = state.temperature;
        this.pyrolyzedTotal += state.pyrolyzedTotal;
        this.charGeneratedTotal += state.charGeneratedTotal;
        this.charBurnedTotal += state.charBurnedTotal;
        this.volatileGeneratedTotal += state.volatileGeneratedTotal;
        this.volatileBurnedTotal += state.volatileBurnedTotal;
        this.smokeGeneratedTotal += state.smokeGeneratedTotal;
        this.exhaustTotal += state.exhaustGas - previousExhaust;
      }
    }
  }

  addBuoyancy(dt) {
    for (let i = 0; i < N; i += 1) {
      if (this.solid[i]) continue;
      const dT = clamp(this.temperature[i] - AMBIENT_T, 0, 160);
      const ay = -9.81 * (1 / 298.15) * dT * 40;
      this.v[i] += ay * dt;
    }
  }

  advectField(dst, src, velocityU, velocityV, dt, fallback, wallSafe, conserve = false) {
    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const i = idx(x, y);
        if (this.solid[i]) {
          dst[i] = fallback;
          continue;
        }
        const px = (x + 0.5) * H;
        const py = (y + 0.5) * H;
        const bx = px - velocityU[i] * dt;
        const by = py - velocityV[i] * dt;
        if (wallSafe) {
          const status = this.traceStatus(px, py, bx, by);
          if (status === 'solid') {
            dst[i] = src[i];
            continue;
          }
          if (status === 'outside') {
            dst[i] = fallback;
            continue;
          }
        }
        dst[i] = this.sampleField(src, bx, by, src[i]);
      }
    }

    if (!conserve) return;
    let sourceTotal = 0;
    let destinationTotal = 0;
    for (let i = 0; i < N; i += 1) {
      if (this.solid[i]) continue;
      sourceTotal += Math.max(0, src[i]);
      destinationTotal += Math.max(0, dst[i]);
    }
    if (sourceTotal <= 1e-8) {
      for (let i = 0; i < N; i += 1) {
        if (!this.solid[i]) dst[i] = 0;
      }
      return;
    }
    if (destinationTotal <= 1e-8) return;
    const correction = sourceTotal / destinationTotal;
    for (let i = 0; i < N; i += 1) {
      if (!this.solid[i]) dst[i] = Math.max(0, dst[i] * correction);
    }
  }

  applyWallThermalExchange(dt) {
    if (!(dt > 0)) return;

    this.temperaturePrev.set(this.temperature);
    this.wallInnerTemperaturePrev.set(this.wallInnerTemperature);
    this.wallOuterTemperaturePrev.set(this.wallOuterTemperature);
    this.wallInnerDelta.fill(0);
    this.wallOuterDelta.fill(0);
    this.fluidThermalDelta.fill(0);

    const {
      referenceConductivity,
      couplingRate,
      wallHeatCapacity,
      surfaceHeatCapacity,
      throughWallRate,
    } = WALL_CONDUCTION_PARAMS;
    const surfaceCapacity = Math.max(surfaceHeatCapacity, wallHeatCapacity * 0.5);
    const interfaceRate = (conductivity) => clamp(
      Math.max(0, conductivity) / Math.max(referenceConductivity, 1e-6) * couplingRate * dt,
      0,
      0.24,
    );
    const slabRate = (conductivity) => clamp(
      Math.max(0, conductivity) / Math.max(referenceConductivity, 1e-6) * throughWallRate * dt,
      0,
      0.24,
    );
    const harmonicConductivity = (a, b) => {
      if (a <= 0 || b <= 0) return 0;
      return (2 * a * b) / (a + b);
    };

    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const i = idx(x, y);
        if (!this.solid[i]) continue;

        const innerTemperature = this.wallInnerTemperaturePrev[i];
        const outerTemperature = this.wallOuterTemperaturePrev[i];
        const conductivity = this.wallConductivity[i];
        const throughWall = (outerTemperature - innerTemperature) * slabRate(conductivity);
        this.wallInnerDelta[i] += throughWall;
        this.wallOuterDelta[i] -= throughWall;

        let hasOuterFluid = false;
        for (const { dx, dy, bit } of WALL_FACE_DIRECTIONS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= NX || ny >= NY) continue;
          const neighbour = idx(nx, ny);
          if (this.solid[neighbour]) {
            const neighbourConductivity = this.wallConductivity[neighbour];
            const interfaceConductivity = harmonicConductivity(conductivity, neighbourConductivity);
            const response = interfaceRate(interfaceConductivity) / surfaceCapacity;
            const innerTransfer = (this.wallInnerTemperaturePrev[neighbour] - innerTemperature) * response;
            const outerTransfer = (this.wallOuterTemperaturePrev[neighbour] - outerTemperature) * response;
            this.wallInnerDelta[i] += innerTransfer;
            this.wallOuterDelta[i] += outerTransfer;
            continue;
          }

          const isInnerFace = (this.wallInnerFaceMask[i] & bit) !== 0;
          const surfaceDelta = isInnerFace ? this.wallInnerDelta : this.wallOuterDelta;
          const surfaceTemperature = isInnerFace ? innerTemperature : outerTemperature;
          const fluidTemperature = this.temperaturePrev[neighbour];
          const conductiveTransfer = (surfaceTemperature - fluidTemperature) * interfaceRate(conductivity);
          const radiativeTransfer = radiativeHeatTransfer(surfaceTemperature, fluidTemperature, dt);
          this.fluidThermalDelta[neighbour] += conductiveTransfer + radiativeTransfer;
          surfaceDelta[i] -= conductiveTransfer / surfaceCapacity;
          surfaceDelta[i] -= radiativeTransfer / surfaceCapacity;
          if (!isInnerFace) hasOuterFluid = true;
        }

        if (!hasOuterFluid) {
          const ambientRadiation = radiativeHeatTransfer(outerTemperature, AMBIENT_T, dt);
          this.wallOuterDelta[i] -= ambientRadiation / surfaceCapacity;
        }
      }
    }

    for (let i = 0; i < N; i += 1) {
      if (this.solid[i]) {
        const innerTemperature = clamp(
          this.wallInnerTemperaturePrev[i] + this.wallInnerDelta[i],
          AMBIENT_T,
          MAX_T,
        );
        const outerTemperature = clamp(
          this.wallOuterTemperaturePrev[i] + this.wallOuterDelta[i],
          AMBIENT_T,
          MAX_T,
        );
        this.wallInnerTemperature[i] = innerTemperature;
        this.wallOuterTemperature[i] = outerTemperature;
        this.wallTemperature[i] = (innerTemperature + outerTemperature) * 0.5;
      } else {
        this.temperature[i] = clamp(
          this.temperaturePrev[i] + this.fluidThermalDelta[i],
          AMBIENT_T,
          MAX_T,
        );
      }
    }
  }

  // Keep the previous internal name available to deterministic tests and
  // integrations while the pass now includes surface radiation as well.
  applyWallConduction(dt) {
    this.applyWallThermalExchange(dt);
  }

  traceStatus(x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const distance = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(distance / TRACE_STEP));
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const x = x0 + dx * t;
      const y = y0 + dy * t;
      if (!inCanvas(x, y)) return 'outside';
      if (this.isSolidPoint(x, y)) return 'solid';
    }
    return 'fluid';
  }

  sampleField(field, px, py, fallback = 0) {
    if (!inCanvas(px, py)) return fallback;
    const gx = px / H - 0.5;
    const gy = py / H - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = gx - x0;
    const ty = gy - y0;
    let sum = 0;
    let weight = 0;
    for (let oy = 0; oy <= 1; oy += 1) {
      for (let ox = 0; ox <= 1; ox += 1) {
        const x = x0 + ox;
        const y = y0 + oy;
        if (x < 0 || y < 0 || x >= NX || y >= NY) continue;
        const i = idx(x, y);
        if (this.solid[i]) continue;
        const w = (ox ? tx : 1 - tx) * (oy ? ty : 1 - ty);
        if (w <= 0) continue;
        sum += field[i] * w;
        weight += w;
      }
    }
    return weight > 1e-6 ? sum / weight : fallback;
  }

  projectVelocity() {
    this.pressure.fill(0);
    this.pressureNext.fill(0);
    this.divergence.fill(0);

    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const i = idx(x, y);
        if (this.solid[i]) {
          this.u[i] = 0;
          this.v[i] = 0;
          continue;
        }
        const uL = this.neighbourVelocity(this.u, x - 1, y, 0);
        const uR = this.neighbourVelocity(this.u, x + 1, y, 0);
        const vU = this.neighbourVelocity(this.v, x, y - 1, 0);
        const vD = this.neighbourVelocity(this.v, x, y + 1, 0);
        this.divergence[i] = (uR - uL + vD - vU) / (2 * H);
      }
    }

    for (let iter = 0; iter < PRESSURE_ITERS; iter += 1) {
      for (let y = 0; y < NY; y += 1) {
        for (let x = 0; x < NX; x += 1) {
          const i = idx(x, y);
          if (this.solid[i]) {
            this.pressureNext[i] = 0;
            continue;
          }
          let sum = 0;
          let count = 0;
          for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
            if (nx < 0 || ny < 0 || nx >= NX || ny >= NY) {
              count += 1;
              continue;
            }
            const ni = idx(nx, ny);
            if (this.solid[ni]) continue;
            sum += this.pressure[ni];
            count += 1;
          }
          this.pressureNext[i] = count
            ? (sum - this.divergence[i] * H * H) / count
            : 0;
        }
      }
      this.pressure.set(this.pressureNext);
    }

    let residual = 0;
    let residualCount = 0;
    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const i = idx(x, y);
        if (this.solid[i]) continue;
        const pc = this.pressure[i];
        const pL = this.neighbourPressure(x - 1, y, pc);
        const pR = this.neighbourPressure(x + 1, y, pc);
        const pU = this.neighbourPressure(x, y - 1, pc);
        const pD = this.neighbourPressure(x, y + 1, pc);
        this.u[i] -= (pR - pL) / (2 * H);
        this.v[i] -= (pD - pU) / (2 * H);
        this.enforceWallVelocity(x, y, i);
        const speed = Math.hypot(this.u[i], this.v[i]);
        if (speed > MAX_SPEED) {
          this.u[i] = (this.u[i] / speed) * MAX_SPEED;
          this.v[i] = (this.v[i] / speed) * MAX_SPEED;
        }
        const uL = this.neighbourVelocity(this.u, x - 1, y, this.u[i]);
        const uR = this.neighbourVelocity(this.u, x + 1, y, this.u[i]);
        const vU = this.neighbourVelocity(this.v, x, y - 1, this.v[i]);
        const vD = this.neighbourVelocity(this.v, x, y + 1, this.v[i]);
        residual += Math.abs((uR - uL + vD - vU) / (2 * H));
        residualCount += 1;
      }
    }
    this.lastPressureResidual = residualCount ? residual / residualCount : 0;
    this.balanceOpenBoundaryFlux();
    this.measureBoundaryFlux();
  }

  neighbourVelocity(field, x, y, fallback) {
    if (x < 0 || y < 0 || x >= NX || y >= NY) return fallback;
    const i = idx(x, y);
    return this.solid[i] ? 0 : field[i];
  }

  neighbourPressure(x, y, current) {
    if (x < 0 || y < 0 || x >= NX || y >= NY) return 0;
    const i = idx(x, y);
    return this.solid[i] ? current : this.pressure[i];
  }

  enforceWallVelocity(x, y, i) {
    if (x > 0 && this.solid[idx(x - 1, y)] && this.u[i] < 0) this.u[i] = 0;
    if (x < NX - 1 && this.solid[idx(x + 1, y)] && this.u[i] > 0) this.u[i] = 0;
    if (y > 0 && this.solid[idx(x, y - 1)] && this.v[i] < 0) this.v[i] = 0;
    if (y < NY - 1 && this.solid[idx(x, y + 1)] && this.v[i] > 0) this.v[i] = 0;
  }

  balanceOpenBoundaryFlux() {
    const faces = [];
    for (let x = 0; x < NX; x += 1) {
      if (!this.solid[idx(x, 0)]) faces.push({ i: idx(x, 0), axis: 'v', sign: -1 });
      if (!this.solid[idx(x, NY - 1)]) faces.push({ i: idx(x, NY - 1), axis: 'v', sign: 1 });
    }
    for (let y = 0; y < NY; y += 1) {
      if (!this.solid[idx(0, y)]) faces.push({ i: idx(0, y), axis: 'u', sign: -1 });
      if (!this.solid[idx(NX - 1, y)]) faces.push({ i: idx(NX - 1, y), axis: 'u', sign: 1 });
    }
    if (!faces.length) return;
    let net = 0;
    for (const face of faces) {
      const value = face.axis === 'u' ? this.u[face.i] : this.v[face.i];
      net += face.sign * value;
    }
    const correction = net / faces.length;
    for (const face of faces) {
      const outward = face.sign * (face.axis === 'u' ? this.u[face.i] : this.v[face.i]);
      const next = outward - correction;
      if (face.axis === 'u') this.u[face.i] = face.sign * next;
      else this.v[face.i] = face.sign * next;
    }
  }

  measureBoundaryFlux() {
    let inflow = 0;
    let outflow = 0;
    const add = (outward) => {
      if (outward >= 0) outflow += outward;
      else inflow += -outward;
    };
    for (let x = 0; x < NX; x += 1) {
      add(-this.v[idx(x, 0)]);
      add(this.v[idx(x, NY - 1)]);
    }
    for (let y = 0; y < NY; y += 1) {
      add(-this.u[idx(0, y)]);
      add(this.u[idx(NX - 1, y)]);
    }
    this.lastInflow = inflow;
    this.lastOutflow = outflow;
  }

  coolAndMix(dt) {
    for (let i = 0; i < N; i += 1) {
      if (this.solid[i]) continue;
      this.temperature[i] = clamp(
        this.temperature[i] + (AMBIENT_T - this.temperature[i]) * 0.018 * dt,
        AMBIENT_T,
        MAX_T
      );
      this.oxygen[i] = clamp(this.oxygen[i], 0, 1);
      this.smoke[i] = Math.max(0, this.smoke[i]);
      this.volatileGas[i] = Math.max(0, this.volatileGas[i]);
    }
  }

  updateSecondaryResidence(dt) {
    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const i = idx(x, y);
        if (this.solid[i]) continue;
        const reactive = this.smoke[i] + this.volatileGas[i];
        const hot = this.temperature[i] >= 260;
        const moving = Math.hypot(this.u[i], this.v[i]) >= 1.5;
        if (reactive > 0.0005 && hot && moving) {
          this.secondaryResidence[i] = clamp(this.secondaryResidence[i] + dt, 0, 2);
        } else {
          this.secondaryResidence[i] = Math.max(0, this.secondaryResidence[i] - dt * 1.6);
        }
      }
    }
  }

  applySecondaryCombustion(dt) {
    let reacted = 0;
    const state = this.fuelWork;
    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const i = idx(x, y);
        if (this.solid[i] || this.smoke[i] <= 0) continue;

        state.rawStraw = 0;
        state.char = 0;
        state.mineralMatter = 0;
        state.ash = 0;
        state.volatileGas = 0;
        state.smoke = this.smoke[i];
        state.exhaustGas = this.exhaustGas[i];
        const previousExhaust = state.exhaustGas;
        state.oxygen = this.oxygen[i];
        state.temperature = this.temperature[i];
        state.smokeOxidizedTotal = 0;

        stepSecondarySmokeOxidation(
          state,
          dt,
          {
            mixing: this.localMixing(x, y, i),
            residenceTime: this.secondaryResidence[i],
          },
          FUEL,
        );

        this.smoke[i] = state.smoke;
        this.exhaustGas[i] = state.exhaustGas;
        this.oxygen[i] = state.oxygen;
        this.temperature[i] = state.temperature;
        this.exhaustTotal += state.exhaustGas - previousExhaust;
        reacted += state.smokeOxidizedTotal;
      }
    }
    this.lastSecondaryRate = reacted / Math.max(dt, 1e-6);
  }

  localMixing(x, y, i) {
    const left = x > 0 ? idx(x - 1, y) : i;
    const right = x < NX - 1 ? idx(x + 1, y) : i;
    const up = y > 0 ? idx(x, y - 1) : i;
    const down = y < NY - 1 ? idx(x, y + 1) : i;
    const dvdx = (this.v[right] - this.v[left]) / (2 * H);
    const dudy = (this.u[down] - this.u[up]) / (2 * H);
    const vorticity = Math.abs(dvdx - dudy) * H;
    const speed = Math.hypot(this.u[i], this.v[i]);
    return clamp(0.16 + speed / 80 + vorticity / 24, 0.16, 1);
  }

  applyOpenBoundaryExchange(dt) {
    const removeGas = (field, i, amount) => {
      const removed = Math.max(0, field[i] * amount);
      field[i] = Math.max(0, field[i] - removed);
      return removed;
    };
    const freshen = (i, rate) => {
      const k = clamp(rate * dt, 0, 1);
      this.temperature[i] += (AMBIENT_T - this.temperature[i]) * k;
      this.oxygen[i] += (AMBIENT_O2 - this.oxygen[i]) * k;
      this.smokeOutTotal += removeGas(this.smoke, i, k);
      this.volatileOutTotal += removeGas(this.volatileGas, i, k);
      this.exhaustOutTotal += removeGas(this.exhaustGas, i, k);
    };
    const recordOut = (i, outward) => {
      if (outward <= 0 || this.solid[i]) return;
      const k = clamp(outward * dt / H, 0, 1);
      this.smokeOutTotal += removeGas(this.smoke, i, k);
      this.volatileOutTotal += removeGas(this.volatileGas, i, k);
      this.exhaustOutTotal += removeGas(this.exhaustGas, i, k);
    };

    for (let x = 0; x < NX; x += 1) {
      const top = idx(x, 0);
      const bottom = idx(x, NY - 1);
      if (!this.solid[top]) {
        if (this.v[top] > 0) freshen(top, Math.max(1, this.v[top] / H));
        else recordOut(top, -this.v[top]);
      }
      if (!this.solid[bottom]) {
        if (this.v[bottom] < 0) freshen(bottom, Math.max(1, -this.v[bottom] / H));
        else recordOut(bottom, this.v[bottom]);
      }
    }
    for (let y = 0; y < NY; y += 1) {
      const left = idx(0, y);
      const right = idx(NX - 1, y);
      if (!this.solid[left]) {
        if (this.u[left] > 0) freshen(left, Math.max(1, this.u[left] / H));
        else recordOut(left, -this.u[left]);
      }
      if (!this.solid[right]) {
        if (this.u[right] < 0) freshen(right, Math.max(1, -this.u[right] / H));
        else recordOut(right, this.u[right]);
      }
    }
  }

  seedTracers(count = DEFAULT_TRACERS) {
    const random = seededRandom(20260901);
    this.tracers = [];
    let attempts = 0;
    while (this.tracers.length < count && attempts < count * 40) {
      attempts += 1;
      const x = random() * SIM_WIDTH;
      const y = random() * SIM_HEIGHT;
      if (!this.isSolidPoint(x, y)) this.tracers.push({ x, y });
    }
  }

  relocateTracersOutOfSolids() {
    for (const p of this.tracers) {
      if (!this.isSolidPoint(p.x, p.y)) continue;
      const replacement = this.findFluidPointNear(p.x, p.y);
      if (replacement) {
        p.x = replacement.x;
        p.y = replacement.y;
      }
    }
  }

  findFluidPointNear(px, py) {
    const gx = gridX(px);
    const gy = gridY(py);
    for (let radius = 1; radius < 8; radius += 1) {
      for (let y = Math.max(0, gy - radius); y <= Math.min(NY - 1, gy + radius); y += 1) {
        for (let x = Math.max(0, gx - radius); x <= Math.min(NX - 1, gx + radius); x += 1) {
          const i = idx(x, y);
          if (!this.solid[i]) return { x: (x + 0.5) * H, y: (y + 0.5) * H };
        }
      }
    }
    return null;
  }

  updateTracers(dt) {
    for (const p of this.tracers) {
      const vx = this.sampleField(this.u, p.x, p.y, 0);
      const vy = this.sampleField(this.v, p.x, p.y, 0);
      const nx = p.x + vx * dt;
      const ny = p.y + vy * dt;
      if (!inCanvas(nx, ny)) {
        this.respawnTracerAtInflow(p);
        continue;
      }
      if (!this.segmentHitsSolid(p.x, p.y, nx, ny)) {
        p.x = nx;
        p.y = ny;
        continue;
      }
      const tryX = { x: nx, y: p.y };
      const tryY = { x: p.x, y: ny };
      if (!this.segmentHitsSolid(p.x, p.y, tryX.x, tryX.y)) p.x = tryX.x;
      else if (!this.segmentHitsSolid(p.x, p.y, tryY.x, tryY.y)) p.y = tryY.y;
    }
  }

  segmentHitsSolid(x0, y0, x1, y1) {
    const distance = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(distance / TRACE_STEP));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      if (this.isSolidPoint(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return true;
    }
    return false;
  }

  respawnTracerAtInflow(p) {
    const candidates = [];
    for (let x = 0; x < NX; x += 2) {
      const top = idx(x, 0);
      const bottom = idx(x, NY - 1);
      if (!this.solid[top] && this.v[top] > 0) candidates.push({ x: (x + 0.5) * H, y: 2 });
      if (!this.solid[bottom] && this.v[bottom] < 0) candidates.push({ x: (x + 0.5) * H, y: SIM_HEIGHT - 2 });
    }
    for (let y = 0; y < NY; y += 2) {
      const left = idx(0, y);
      const right = idx(NX - 1, y);
      if (!this.solid[left] && this.u[left] > 0) candidates.push({ x: 2, y: (y + 0.5) * H });
      if (!this.solid[right] && this.u[right] < 0) candidates.push({ x: SIM_WIDTH - 2, y: (y + 0.5) * H });
    }
    const chosen = candidates.length
      ? candidates[Math.floor((this.time * 97 + p.x + p.y) % candidates.length)]
      : { x: 2, y: clamp(p.y, 2, SIM_HEIGHT - 2) };
    p.x = chosen.x;
    p.y = chosen.y;
  }

  isSolidPoint(px, py) {
    if (!inCanvas(px, py)) return false;
    return this.solid[idx(gridX(px), gridY(py))] === 1;
  }

  sum(field) {
    let total = 0;
    for (let i = 0; i < N; i += 1) total += field[i];
    return total;
  }

  average(field, predicate = null) {
    let total = 0;
    let count = 0;
    for (let i = 0; i < N; i += 1) {
      if (this.solid[i]) continue;
      if (predicate && !predicate(i)) continue;
      total += field[i];
      count += 1;
    }
    return count ? total / count : 0;
  }

  diagnostics() {
    let speed = 0;
    let fluidCells = 0;
    let fuelO2 = 0;
    let fuelTemperature = 0;
    let fuelCells = 0;
    let wallTemperature = 0;
    let wallInnerTemperature = 0;
    let wallOuterTemperature = 0;
    let wallRadiationLoss = 0;
    let wallConductivity = 0;
    let wallCells = 0;
    for (let i = 0; i < N; i += 1) {
      if (this.solid[i]) {
        wallTemperature += this.wallTemperature[i];
        wallInnerTemperature += this.wallInnerTemperature[i];
        wallOuterTemperature += this.wallOuterTemperature[i];
        wallRadiationLoss += Math.max(
          0,
          radiativeHeatFlux(this.wallOuterTemperature[i], AMBIENT_T),
        );
        wallConductivity += this.wallConductivity[i];
        wallCells += 1;
      } else {
        speed += Math.hypot(this.u[i], this.v[i]);
        fluidCells += 1;
      }
      if (this.fuelMask[i]) {
        fuelO2 += this.oxygen[i];
        fuelTemperature += this.temperature[i];
        fuelCells += 1;
      }
    }

    const raw = this.sum(this.rawStraw);
    const char = this.sum(this.char);
    const mineral = this.sum(this.mineralMatter);
    const ash = this.sum(this.ash);
    const volatile = this.sum(this.volatileGas);
    const smoke = this.sum(this.smoke);
    const exhaustInDomain = this.sum(this.exhaustGas);
    const pyrolysisFraction = this.initialOrganic > 1e-9
      ? clamp(1 - raw / this.initialOrganic)
      : 0;
    const charRetention = this.charGeneratedTotal > 1e-9
      ? clamp(char / this.charGeneratedTotal)
      : 0;
    // `exhaustTotal` is the reaction ledger. `exhaustGas` is only an advected
    // in-domain concentration and must not be added again, or convergent
    // advection would double-count the same reacted material.
    const organicAccounted = raw + char + volatile + smoke + this.exhaustTotal + this.smokeOutTotal + this.volatileOutTotal;
    const mineralAccounted = mineral + ash;
    const averageFuelTemperature = fuelCells
      ? fuelTemperature / fuelCells
      : AMBIENT_T;
    const fuelPhase = getFuelPhase({
      ignited: this.ignited,
      ignitionRemaining: this.ignitionRemaining,
      rawStraw: raw,
      char,
      volatileGas: volatile,
      oxygen: fuelCells ? fuelO2 / fuelCells : 0,
      temperature: averageFuelTemperature,
    });

    return {
      time: this.time,
      rawStraw: raw,
      char,
      mineralMatter: mineral,
      ash,
      volatileGas: volatile,
      smoke,
      exhaustGas: exhaustInDomain,
      averageSpeed: fluidCells ? speed / fluidCells : 0,
      fuelOxygen: fuelCells ? fuelO2 / fuelCells : 0,
      fuelTemperature: averageFuelTemperature,
      fuelPhase,
      reactiveFuel: raw + char + volatile,
      averageTemperature: this.average(this.temperature),
      wallTemperature: wallCells ? wallTemperature / wallCells : AMBIENT_T,
      wallInnerTemperature: wallCells ? wallInnerTemperature / wallCells : AMBIENT_T,
      wallOuterTemperature: wallCells ? wallOuterTemperature / wallCells : AMBIENT_T,
      wallRadiationLoss: wallCells ? wallRadiationLoss / wallCells : 0,
      averageWallConductivity: wallCells ? wallConductivity / wallCells : 0,
      smokeOut: this.smokeOutTotal,
      volatileOut: this.volatileOutTotal,
      exhaustOut: this.exhaustOutTotal,
      secondaryRate: this.lastSecondaryRate,
      pressureResidual: this.lastPressureResidual,
      inflow: this.lastInflow,
      outflow: this.lastOutflow,
      pyrolysisFraction,
      charRetention,
      carbonizationIndex: 100 * pyrolysisFraction * charRetention,
      organicError: organicAccounted - this.initialOrganic,
      mineralError: mineralAccounted - this.initialMineral,
    };
  }
}

export const simulationInternals = { idx, gridX, gridY, clamp, smoothstep };
