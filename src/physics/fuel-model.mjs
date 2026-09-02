const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smoothstep = (x) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};

// Canonical Physics v3 fuel parameters. CPU, GPU host uniforms and tests all
// import this object; WGSL keeps the same field names in its parameter blocks.
export const DEFAULT_FUEL_PARAMS = Object.freeze({
  ambientTemperature: 25,
  maxTemperature: 700,
  ignitionHeatRate: 230,

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

export const FUEL_PHASES = Object.freeze({
  UNLIT: 'unlit',
  BURNING: 'burning',
  EXTINGUISHED: 'extinguished',
});

const ACTIVE_FUEL_EPSILON = 1e-4;

/**
 * Derive the visible fuel phase from the physical quantities already tracked
 * by Physics v3. The starter flame is only a temporary heat source; it does
 * not define how long the fuel can keep reacting.
 */
export function getFuelPhase({
  ignited = false,
  ignitionRemaining = 0,
  rawStraw = 0,
  char = 0,
  volatileGas = 0,
  oxygen = 0,
  temperature = Number(DEFAULT_FUEL_PARAMS.ambientTemperature),
} = {}) {
  if (!ignited) return FUEL_PHASES.UNLIT;

  const reactiveFuel =
    Math.max(0, rawStraw) + Math.max(0, char) + Math.max(0, volatileGas);
  if (reactiveFuel <= ACTIVE_FUEL_EPSILON) return FUEL_PHASES.EXTINGUISHED;
  if (ignitionRemaining > 0) return FUEL_PHASES.BURNING;

  const volatileBurning =
    volatileGas > ACTIVE_FUEL_EPSILON &&
    temperature >= DEFAULT_FUEL_PARAMS.volatileBurnStartTemperature;
  const charBurning =
    char > ACTIVE_FUEL_EPSILON &&
    temperature >= DEFAULT_FUEL_PARAMS.charOxidationStartTemperature;
  const oxygenAvailable = oxygen >= 0.06;

  return oxygenAvailable && (volatileBurning || charBurning)
    ? FUEL_PHASES.BURNING
    : FUEL_PHASES.EXTINGUISHED;
}

export function createFuelState({
  rawStraw = 1,
  mineralMatter = 0.12,
  oxygen = 1,
  temperature = DEFAULT_FUEL_PARAMS.ambientTemperature,
} = {}) {
  return {
    rawStraw,
    char: 0,
    mineralMatter,
    ash: 0,
    volatileGas: 0,
    smoke: 0,
    exhaustGas: 0,
    oxygen,
    temperature,

    pyrolyzedTotal: 0,
    charGeneratedTotal: 0,
    charBurnedTotal: 0,
    volatileGeneratedTotal: 0,
    volatileBurnedTotal: 0,
    smokeGeneratedTotal: 0,
    smokeOxidizedTotal: 0,
  };
}

function ignitionStep(s, dt, p) {
  const activeFuel = s.rawStraw + s.char;
  if (activeFuel <= 1e-8) return;
  s.temperature = clamp(
    s.temperature + p.ignitionHeatRate * dt,
    p.ambientTemperature,
    p.maxTemperature,
  );
}

function pyrolysisStep(s, dt, p) {
  const tempFactor = smoothstep(
    (s.temperature - p.pyrolysisStartTemperature) /
      (p.pyrolysisFullTemperature - p.pyrolysisStartTemperature)
  );
  if (tempFactor <= 0 || s.rawStraw <= 0) return;

  const converted = Math.min(
    s.rawStraw,
    s.rawStraw * p.pyrolysisRate * tempFactor * dt
  );
  if (converted <= 0) return;

  const charMade = converted * p.charYield;
  const volatileMade = converted * p.volatileYield;

  s.rawStraw -= converted;
  s.char += charMade;
  s.volatileGas += volatileMade;
  s.pyrolyzedTotal += converted;
  s.charGeneratedTotal += charMade;
  s.volatileGeneratedTotal += volatileMade;
}

function volatileCombustionStep(s, dt, env, p) {
  if (s.volatileGas <= 0) return;

  const tempFactor = smoothstep(
    (s.temperature - p.volatileBurnStartTemperature) /
      (p.volatileBurnFullTemperature - p.volatileBurnStartTemperature)
  );
  const oxygenFactor = clamp((s.oxygen - 0.04) / 0.72);
  const mixing = clamp(env.mixing ?? 0.5);

  const completeness = clamp(tempFactor * oxygenFactor * (0.25 + 0.75 * mixing));
  const burnPotential = s.volatileGas * p.volatileBurnRate * completeness * dt;
  const maxByOxygen = s.oxygen / Math.max(1e-6, p.volatileOxygenUse);
  const burned = Math.min(s.volatileGas, burnPotential, maxByOxygen);

  if (burned > 0) {
    s.volatileGas -= burned;
    s.oxygen = clamp(s.oxygen - burned * p.volatileOxygenUse);
    s.exhaustGas += burned;
    s.temperature = clamp(
      s.temperature + burned * p.volatileHeatGain,
      p.ambientTemperature,
      p.maxTemperature,
    );
    s.volatileBurnedTotal += burned;
  }

  const hotEnoughToSmoke = smoothstep((s.temperature - 110) / 180);
  const poorCombustion = 1 - completeness;
  const smokeYield =
    p.cleanSmokeYield + p.dirtySmokeYield * Math.pow(poorCombustion, 1.35);
  const smokeSource = Math.min(
    s.volatileGas,
    s.volatileGas * smokeYield * hotEnoughToSmoke * dt
  );

  if (smokeSource > 0) {
    s.volatileGas -= smokeSource;
    s.smoke += smokeSource;
    s.smokeGeneratedTotal += smokeSource;
  }
}

function secondarySmokeOxidationStep(s, dt, env, p) {
  if (s.smoke <= 0) return;
  const tempFactor = smoothstep((s.temperature - 260) / 300);
  const oxygenFactor = clamp((s.oxygen - 0.08) / 0.65);
  const mixing = clamp(env.mixing ?? 0.5);
  const residence = clamp((env.residenceTime ?? 0) / 0.75);
  const secondary = tempFactor * oxygenFactor * mixing * residence;
  if (secondary <= 0) return;

  const potential = s.smoke * p.secondarySmokeOxidationRate * secondary * dt;
  const maxByOxygen = s.oxygen / Math.max(1e-6, p.secondarySmokeOxygenUse);
  const oxidized = Math.min(s.smoke, potential, maxByOxygen);
  if (oxidized <= 0) return;

  s.smoke -= oxidized;
  s.oxygen = clamp(s.oxygen - oxidized * p.secondarySmokeOxygenUse);
  s.exhaustGas += oxidized;
  s.temperature = clamp(
    s.temperature + oxidized * p.secondaryHeatGain,
    p.ambientTemperature,
    p.maxTemperature,
  );
  s.smokeOxidizedTotal += oxidized;
}

function charOxidationStep(s, dt, p) {
  if (s.char <= 0) return;

  const tempFactor = smoothstep(
    (s.temperature - p.charOxidationStartTemperature) /
      (p.charOxidationFullTemperature - p.charOxidationStartTemperature)
  );
  const oxygenFactor = clamp((s.oxygen - 0.06) / 0.7);
  const potential = s.char * p.charOxidationRate * tempFactor * oxygenFactor * dt;
  const maxByOxygen = s.oxygen / Math.max(1e-6, p.charOxygenUse);
  const oxidized = Math.min(s.char, potential, maxByOxygen);
  if (oxidized <= 0) return;

  s.char -= oxidized;
  s.oxygen = clamp(s.oxygen - oxidized * p.charOxygenUse);
  s.exhaustGas += oxidized;
  s.temperature = clamp(
    s.temperature + oxidized * p.charHeatGain,
    p.ambientTemperature,
    p.maxTemperature,
  );
  s.charBurnedTotal += oxidized;

  // Ash is exposed from the independent mineral reservoir; carbon is NOT converted to minerals.
  const exposed = Math.min(
    s.mineralMatter,
    oxidized * p.ashExposurePerCharOxidized
  );
  s.mineralMatter -= exposed;
  s.ash += exposed;
}

/** Run ignition, pyrolysis, volatile combustion and char oxidation. */
export function stepPrimaryFuelModel(state, dt, env = {}, params = DEFAULT_FUEL_PARAMS) {
  if (!(dt > 0)) return state;
  if (env.ignitionActive) ignitionStep(state, dt, params);
  pyrolysisStep(state, dt, params);
  volatileCombustionStep(state, dt, env, params);
  charOxidationStep(state, dt, params);
  return state;
}

/** Run only the post-transport smoke oxidation phase. */
export function stepSecondarySmokeOxidation(
  state,
  dt,
  env = {},
  params = DEFAULT_FUEL_PARAMS,
) {
  if (!(dt > 0)) return state;
  secondarySmokeOxidationStep(state, dt, env, params);
  return state;
}

/** Convenience one-cell model used by focused fuel tests and experiments. */
export function stepFuelModel(state, dt, env = {}, params = DEFAULT_FUEL_PARAMS) {
  stepPrimaryFuelModel(state, dt, env, params);
  if (env.includeSecondary !== false) {
    stepSecondarySmokeOxidation(state, dt, env, params);
  }
  return state;
}

export function fuelDiagnostics(state, initial = { rawStraw: 1, mineralMatter: 0.12 }) {
  const organicRemaining = state.rawStraw + state.char + state.volatileGas + state.smoke;
  const organicConvertedToExhaust = state.exhaustGas;
  const organicAccounted = organicRemaining + organicConvertedToExhaust;
  const organicInitial = initial.rawStraw;

  const mineralAccounted = state.mineralMatter + state.ash;
  const mineralInitial = initial.mineralMatter;

  const charYield = state.pyrolyzedTotal > 1e-9
    ? state.charGeneratedTotal / state.pyrolyzedTotal
    : 0;
  const charRetention = state.charGeneratedTotal > 1e-9
    ? state.char / state.charGeneratedTotal
    : 0;
  const pyrolysisFraction = initial.rawStraw > 1e-9
    ? 1 - state.rawStraw / initial.rawStraw
    : 0;

  return {
    organicError: organicAccounted - organicInitial,
    mineralError: mineralAccounted - mineralInitial,
    charYield,
    charRetention,
    pyrolysisFraction,
    carbonizationIndex: 100 * clamp(pyrolysisFraction * charRetention),
  };
}
