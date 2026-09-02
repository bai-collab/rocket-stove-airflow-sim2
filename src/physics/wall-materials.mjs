/**
 * Wall materials use representative teaching values for thermal conductivity.
 * The solver normalizes them against the common-brick reference value, so the
 * numbers are useful for comparison rather than a claim of laboratory accuracy.
 * Surface radiation uses an effective grid-scale factor; it is not a calibrated
 * prediction of a particular brick's W/m² heat loss.
 */
export const WALL_CONDUCTION_PARAMS = Object.freeze({
  referenceConductivity: 0.70,
  couplingRate: 0.04,
  wallHeatCapacity: 3,
  surfaceHeatCapacity: 1.5,
  throughWallRate: 0.08,
  emissivity: 0.85,
  stefanBoltzmann: 5.670374419e-8,
  radiationScale: 1.8e-4,
});

export const WALL_FACE_BITS = Object.freeze({
  left: 1,
  right: 2,
  up: 4,
  down: 8,
});

const celsiusToKelvin = (temperatureC) => Math.max(
  1,
  (Number.isFinite(temperatureC) ? temperatureC : 25) + 273.15,
);

/**
 * Return an effective temperature-equivalent radiation rate. Positive values
 * mean the surface is radiating heat into its surroundings.
 */
export function radiativeHeatFlux(surfaceTemperatureC, surroundingsTemperatureC) {
  const surfaceK = celsiusToKelvin(surfaceTemperatureC);
  const surroundingsK = celsiusToKelvin(surroundingsTemperatureC);
  const surfaceK2 = surfaceK * surfaceK;
  const surroundingsK2 = surroundingsK * surroundingsK;
  return WALL_CONDUCTION_PARAMS.emissivity *
    WALL_CONDUCTION_PARAMS.stefanBoltzmann *
    (surfaceK2 * surfaceK2 - surroundingsK2 * surroundingsK2) *
    WALL_CONDUCTION_PARAMS.radiationScale;
}

export function radiativeHeatTransfer(surfaceTemperatureC, surroundingsTemperatureC, dt) {
  if (!(dt > 0)) return 0;
  return Math.max(-0.18, Math.min(0.18,
    radiativeHeatFlux(surfaceTemperatureC, surroundingsTemperatureC) * dt,
  ));
}

export const DEFAULT_WALL_MATERIAL_ID = 'standard';

export const WALL_MATERIALS = Object.freeze({
  insulating: Object.freeze({
    id: 'insulating',
    numericId: 1,
    label: '低導熱隔熱磚',
    conductivity: 0.25,
    color: '#e49a6b',
    stroke: '#a95c3a',
    description: '保溫較好，熱較慢傳到爐壁外側。',
  }),
  standard: Object.freeze({
    id: 'standard',
    numericId: 2,
    label: '中導熱普通磚',
    conductivity: 0.70,
    color: '#a65f47',
    stroke: '#713f2f',
    description: '作為一般紅磚的比較基準。',
  }),
  conductive: Object.freeze({
    id: 'conductive',
    numericId: 3,
    label: '高導熱緻密磚',
    conductivity: 1.30,
    color: '#6f4237',
    stroke: '#482a24',
    description: '熱較快穿過磚體，也較快把熱帶離燃燒區。',
  }),
});

export const WALL_MATERIAL_OPTIONS = Object.freeze(Object.values(WALL_MATERIALS));

export function getWallMaterial(materialId) {
  return WALL_MATERIALS[materialId] ?? WALL_MATERIALS[DEFAULT_WALL_MATERIAL_ID];
}

export function normalizeWallMaterialId(materialId) {
  return getWallMaterial(materialId).id;
}

export function getWallMaterialByNumericId(numericId) {
  return WALL_MATERIAL_OPTIONS.find((material) => material.numericId === numericId)
    ?? WALL_MATERIALS[DEFAULT_WALL_MATERIAL_ID];
}
