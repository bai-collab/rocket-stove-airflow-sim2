import { BUILD_CELL, STOVE_PRESETS } from './presets.mjs';

export const SIM_WIDTH = 900;
export const SIM_HEIGHT = 560;
export const H = 12;
export const NX = Math.ceil(SIM_WIDTH / H);
export const NY = Math.ceil(SIM_HEIGHT / H);
export const N = NX * NY;
export const DT = 1 / 30;
export const AMBIENT_T = 25;
export const AMBIENT_O2 = 1;
export const MAX_T = 700;
export const MAX_SPEED = 180;

const PRESSURE_ITERS = 36;
const TRACE_STEP = Math.max(2, H * 0.35);
const DEFAULT_TRACERS = 320;

const FUEL = Object.freeze({
  pyrolysisStartTemperature: 140,
  pyrolysisFullTemperature: 420,
  pyrolysisRate: 0.22,
  charYield: 0.34,
  volatileYield: 0.66,
  volatileBurnStartTemperature: 180,
  volatileBurnFullTemperature: 520,
  volatileBurnRate: 2.2,
  volatileOxygenUse: 0.34,
  volatileHeatGain: 185,
  cleanSmokeYield: 0.02,
  dirtySmokeYield: 0.58,
  charOxidationStartTemperature: 260,
  charOxidationFullTemperature: 620,
  charOxidationRate: 0.5,
  charOxygenUse: 0.44,
  charHeatGain: 135,
  secondarySmokeOxidationRate: 0.55,
  secondarySmokeOxygenUse: 0.14,
  secondaryHeatGain: 85,
  ashExposurePerCharOxidized: 0.18,
});

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smoothstep = (x) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};
const idx = (x, y) => y * NX + x;
const gridX = (px) => clamp(Math.floor(px / H), 0, NX - 1);
const gridY = (py) => clamp(Math.floor(py / H), 0, NY - 1);
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
    this.solid = new Uint8Array(N);
    this.fuelMask = new Uint8Array(N);

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
    this.solid.fill(0); this.fuelMask.fill(0);
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
    this.walls = preset.walls.map((p) => ({ ...p }));
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

  setToolAt(tool, px, py) {
    const x = snap(px);
    const y = snap(py);
    if (x < 0 || y < 0 || x >= SIM_WIDTH || y >= SIM_HEIGHT) return;
    const same = (p) => p.x === x && p.y === y;

    if (tool === 'wall') {
      if (!this.walls.some(same) && !this.fuels.some(same)) this.walls.push({ x, y });
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

    this.solid.fill(0);
    this.fuelMask.fill(0);

    for (const wall of this.walls) {
      const x0 = Math.floor(wall.x / H);
      const y0 = Math.floor(wall.y / H);
      const x1 = Math.min(NX, Math.ceil((wall.x + BUILD_CELL) / H));
      const y1 = Math.min(NY, Math.ceil((wall.y + BUILD_CELL) / H));
      for (let gy = y0; gy < y1; gy += 1) {
        for (let gx = x0; gx < x1; gx += 1) {
          const i = idx(gx, gy);
          this.solid[i] = 1;
          this.u[i] = 0;
          this.v[i] = 0;
          this.temperature[i] = AMBIENT_T;
          this.oxygen[i] = 0;
          this.smoke[i] = 0;
          this.volatileGas[i] = 0;
        }
      }
    }

    this.rawStraw.fill(0);
    this.char.fill(0);
    this.mineralMatter.fill(0);
    this.ash.fill(0);

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
        } else {
          this.rawStraw[i] = organicPerCell;
          this.mineralMatter[i] = mineralPerCell;
          this.initialOrganic += organicPerCell;
          this.initialMineral += mineralPerCell;
        }
      }
    }

    if (resetFuel) {
      this.initialOrganic = this.sum(this.rawStraw);
      this.initialMineral = this.sum(this.mineralMatter);
    }

    this.relocateTracersOutOfSolids();
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
    this.advectField(this.smoke, this.smokePrev, this.u, this.v, dt, 0, true);
    this.advectField(this.volatileGas, this.volatilePrev, this.u, this.v, dt, 0, true);
    this.advectField(this.exhaustGas, this.exhaustPrev, this.u, this.v, dt, 0, true);
    this.advectField(this.secondaryResidence, this.secondaryResidencePrev, this.u, this.v, dt, 0, true);

    this.coolAndMix(dt);
    this.updateSecondaryResidence(dt);
    this.applySecondaryCombustion(dt);
    this.applyOpenBoundaryExchange(dt);
    this.updateTracers(dt);
  }

  applyFuelTransformation(dt) {
    if (this.ignitionRemaining > 0) {
      this.ignitionRemaining = Math.max(0, this.ignitionRemaining - dt);
      for (let i = 0; i < N; i += 1) {
        if (!this.fuelMask[i] || this.solid[i]) continue;
        const activeFuel = this.rawStraw[i] + this.char[i];
        if (activeFuel <= 1e-8) continue;
        this.temperature[i] = clamp(this.temperature[i] + 230 * dt, AMBIENT_T, MAX_T);
      }
    }

    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const i = idx(x, y);
        if (!this.fuelMask[i] || this.solid[i]) continue;

        const pyroTemp = smoothstep(
          (this.temperature[i] - FUEL.pyrolysisStartTemperature) /
          (FUEL.pyrolysisFullTemperature - FUEL.pyrolysisStartTemperature)
        );
        if (pyroTemp > 0 && this.rawStraw[i] > 0) {
          const converted = Math.min(
            this.rawStraw[i],
            this.rawStraw[i] * FUEL.pyrolysisRate * pyroTemp * dt
          );
          const charMade = converted * FUEL.charYield;
          const volatileMade = converted * FUEL.volatileYield;
          this.rawStraw[i] -= converted;
          this.char[i] += charMade;
          this.volatileGas[i] += volatileMade;
          this.pyrolyzedTotal += converted;
          this.charGeneratedTotal += charMade;
          this.volatileGeneratedTotal += volatileMade;
        }

        if (this.volatileGas[i] > 0) {
          const burnTemp = smoothstep(
            (this.temperature[i] - FUEL.volatileBurnStartTemperature) /
            (FUEL.volatileBurnFullTemperature - FUEL.volatileBurnStartTemperature)
          );
          const o2Factor = clamp((this.oxygen[i] - 0.04) / 0.72);
          const mixing = this.localMixing(x, y, i);
          const completeness = clamp(burnTemp * o2Factor * (0.25 + 0.75 * mixing));
          const burnPotential = this.volatileGas[i] * FUEL.volatileBurnRate * completeness * dt;
          const maxByO2 = this.oxygen[i] / Math.max(1e-6, FUEL.volatileOxygenUse);
          const burned = Math.min(this.volatileGas[i], burnPotential, maxByO2);
          if (burned > 0) {
            this.volatileGas[i] -= burned;
            this.oxygen[i] = clamp(this.oxygen[i] - burned * FUEL.volatileOxygenUse);
            this.exhaustGas[i] += burned;
            this.exhaustTotal += burned;
            this.temperature[i] = clamp(this.temperature[i] + burned * FUEL.volatileHeatGain, AMBIENT_T, MAX_T);
            this.volatileBurnedTotal += burned;
          }

          const hotEnoughToSmoke = smoothstep((this.temperature[i] - 110) / 180);
          const poorCombustion = 1 - completeness;
          const smokeYield = FUEL.cleanSmokeYield + FUEL.dirtySmokeYield * Math.pow(poorCombustion, 1.35);
          const smokeSource = Math.min(
            this.volatileGas[i],
            this.volatileGas[i] * smokeYield * hotEnoughToSmoke * dt
          );
          if (smokeSource > 0) {
            this.volatileGas[i] -= smokeSource;
            this.smoke[i] += smokeSource;
            this.smokeGeneratedTotal += smokeSource;
          }
        }

        if (this.char[i] > 0) {
          const charTemp = smoothstep(
            (this.temperature[i] - FUEL.charOxidationStartTemperature) /
            (FUEL.charOxidationFullTemperature - FUEL.charOxidationStartTemperature)
          );
          const o2Factor = clamp((this.oxygen[i] - 0.06) / 0.7);
          const potential = this.char[i] * FUEL.charOxidationRate * charTemp * o2Factor * dt;
          const maxByO2 = this.oxygen[i] / Math.max(1e-6, FUEL.charOxygenUse);
          const oxidized = Math.min(this.char[i], potential, maxByO2);
          if (oxidized > 0) {
            this.char[i] -= oxidized;
            this.oxygen[i] = clamp(this.oxygen[i] - oxidized * FUEL.charOxygenUse);
            this.exhaustGas[i] += oxidized;
            this.exhaustTotal += oxidized;
            this.temperature[i] = clamp(this.temperature[i] + oxidized * FUEL.charHeatGain, AMBIENT_T, MAX_T);
            this.charBurnedTotal += oxidized;
            const exposed = Math.min(this.mineralMatter[i], oxidized * FUEL.ashExposurePerCharOxidized);
            this.mineralMatter[i] -= exposed;
            this.ash[i] += exposed;
          }
        }
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

  advectField(dst, src, velocityU, velocityV, dt, fallback, wallSafe) {
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
    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const i = idx(x, y);
        if (this.solid[i] || this.smoke[i] <= 0) continue;
        const tempFactor = smoothstep((this.temperature[i] - 260) / 300);
        const oxygenFactor = clamp((this.oxygen[i] - 0.08) / 0.65);
        const mixing = this.localMixing(x, y, i);
        const residence = clamp(this.secondaryResidence[i] / 0.75);
        const secondary = tempFactor * oxygenFactor * mixing * residence;
        if (secondary <= 0) continue;
        const potential = this.smoke[i] * FUEL.secondarySmokeOxidationRate * secondary * dt;
        const maxByO2 = this.oxygen[i] / Math.max(1e-6, FUEL.secondarySmokeOxygenUse);
        const oxidized = Math.min(this.smoke[i], potential, maxByO2);
        if (oxidized <= 0) continue;
        this.smoke[i] -= oxidized;
        this.oxygen[i] = clamp(this.oxygen[i] - oxidized * FUEL.secondarySmokeOxygenUse);
        this.exhaustGas[i] += oxidized;
        this.exhaustTotal += oxidized;
        this.temperature[i] = clamp(this.temperature[i] + oxidized * FUEL.secondaryHeatGain, AMBIENT_T, MAX_T);
        this.smokeOxidizedTotal += oxidized;
        reacted += oxidized;
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
    const freshen = (i, rate) => {
      const k = clamp(rate * dt, 0, 1);
      this.temperature[i] += (AMBIENT_T - this.temperature[i]) * k;
      this.oxygen[i] += (AMBIENT_O2 - this.oxygen[i]) * k;
      this.smoke[i] *= 1 - k;
      this.volatileGas[i] *= 1 - k;
      this.exhaustGas[i] *= 1 - k;
    };
    const recordOut = (i, outward) => {
      if (outward <= 0 || this.solid[i]) return;
      this.smokeOutTotal += this.smoke[i] * outward * dt / H;
      this.volatileOutTotal += this.volatileGas[i] * outward * dt / H;
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
      if (!this.isSolidPoint(nx, ny)) {
        p.x = nx;
        p.y = ny;
        continue;
      }
      const tryX = { x: nx, y: p.y };
      const tryY = { x: p.x, y: ny };
      if (!this.isSolidPoint(tryX.x, tryX.y)) p.x = tryX.x;
      else if (!this.isSolidPoint(tryY.x, tryY.y)) p.y = tryY.y;
    }
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
    let fuelCells = 0;
    for (let i = 0; i < N; i += 1) {
      if (!this.solid[i]) {
        speed += Math.hypot(this.u[i], this.v[i]);
        fluidCells += 1;
      }
      if (this.fuelMask[i]) {
        fuelO2 += this.oxygen[i];
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
    const organicAccounted = raw + char + volatile + smoke + exhaustInDomain + this.smokeOutTotal + this.volatileOutTotal;
    const mineralAccounted = mineral + ash;

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
      averageTemperature: this.average(this.temperature),
      smokeOut: this.smokeOutTotal,
      volatileOut: this.volatileOutTotal,
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
