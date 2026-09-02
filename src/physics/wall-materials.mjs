/**
 * Wall materials use representative teaching values for thermal conductivity.
 * The solver normalizes them against the common-brick reference value, so the
 * numbers are useful for comparison rather than a claim of laboratory accuracy.
 */
export const WALL_CONDUCTION_PARAMS = Object.freeze({
  referenceConductivity: 0.70,
  couplingRate: 0.04,
  wallHeatCapacity: 3,
});

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
