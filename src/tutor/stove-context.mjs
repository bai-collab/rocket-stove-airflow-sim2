import { SIM_HEIGHT, SIM_WIDTH } from '../simulation/CpuRocketSimulation.mjs';
import { BUILD_CELL, STOVE_PRESETS } from '../simulation/presets.mjs';
import { DEFAULT_WALL_MATERIAL_ID, WALL_MATERIALS } from '../physics/wall-materials.mjs';

export const TUTOR_CONTEXT_VERSION = 1;
export const GRID_COLS = Math.ceil(SIM_WIDTH / BUILD_CELL);
export const GRID_ROWS = Math.ceil(SIM_HEIGHT / BUILD_CELL);
export const MAX_RELATED = 3;
export const MAX_SERIES = 60;
export const MAX_QUESTION_LENGTH = 300;
export const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_TEXT = 400;
const MAX_FUELS = 60;
const MAX_TEXT = 200;

/**
 * Metrics the tutor may read and point at. The labels match the metric cards
 * in the browser so a highlighted key always has a visible counterpart.
 */
export const TUTOR_METRICS = Object.freeze({
  averageSpeed: '平均氣流速度',
  fuelOxygen: '燃料區相對氧氣',
  fuelTemperature: '燃料區溫度',
  smoke: '相對黑煙量',
  smokeOut: '黑煙排出累積',
  pyrolysisFraction: '熱裂解比例',
  charRetention: '炭保留率',
  carbonizationIndex: '碳化指標',
  rawStraw: '剩餘稻稈',
  char: '剩餘炭',
  ash: '灰分顯現',
  wallTemperature: '磚牆平均溫度',
  wallInnerTemperature: '磚牆內側溫度',
  wallOuterTemperature: '磚牆外側溫度',
  wallRadiationLoss: '等效輻射散熱',
  averageWallConductivity: '平均磚牆導熱係數',
  secondaryRate: '二次燃燒速率',
  volatileGas: '未燃揮發氣體',
  exhaustOut: '尾氣排出累積',
  averageTemperature: '平均溫度',
});

export const SERIES_METRICS = Object.freeze([
  'fuelOxygen',
  'fuelTemperature',
  'smoke',
  'smokeOut',
  'secondaryRate',
  'charRetention',
]);

const FUEL_PHASES = new Set(['unlit', 'burning', 'extinguished']);
const BACKENDS = new Set(['cpu', 'gpu']);
const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finite = (value, min, max) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 0);
const cellKey = (c, r) => `${c},${r}`;
const inGrid = (c, r) => Number.isInteger(c) && Number.isInteger(r) && c >= 0 && r >= 0 && c < GRID_COLS && r < GRID_ROWS;

/** Browser side: turn simulator state into the compact JSON the tutor reads. */
export function buildStoveContext({ preset, edited, walls, fuels, ignited, backend, diagnostics, series, runStart = 0 }) {
  const toCell = (p) => ({ c: Math.floor(p.x / BUILD_CELL), r: Math.floor(p.y / BUILD_CELL) });
  const latest = {};
  for (const key of Object.keys(TUTOR_METRICS)) latest[key] = Number(diagnostics[key]);
  return {
    version: TUTOR_CONTEXT_VERSION,
    preset,
    edited: edited === true,
    walls: walls.map((w) => ({ ...toCell(w), material: w.materialId ?? DEFAULT_WALL_MATERIAL_ID })),
    fuels: fuels.map(toCell),
    run: {
      ignited: ignited === true,
      time: Number(diagnostics.time),
      startTime: Number(runStart),
      backend,
      fuelPhase: diagnostics.fuelPhase,
      reactiveFuel: Number(diagnostics.reactiveFuel ?? diagnostics.rawStraw + diagnostics.char + diagnostics.volatileGas),
      latest,
      series: series.slice(-MAX_SERIES),
    },
  };
}

/**
 * Server side: rebuild the context from whitelisted, bounded fields only.
 * Anything the browser adds beyond this shape is dropped.
 */
export function sanitizeStoveContext(input) {
  if (!plain(input) || input.version !== TUTOR_CONTEXT_VERSION || !Array.isArray(input.walls) ||
      !Array.isArray(input.fuels) || !plain(input.run)) {
    throw new Error('INVALID_CONTEXT');
  }
  const occupied = new Set();
  const walls = [];
  for (const wall of input.walls.slice(0, GRID_COLS * GRID_ROWS)) {
    if (!plain(wall) || !inGrid(wall.c, wall.r) || occupied.has(cellKey(wall.c, wall.r))) continue;
    occupied.add(cellKey(wall.c, wall.r));
    const material = Object.hasOwn(WALL_MATERIALS, wall.material) ? wall.material : DEFAULT_WALL_MATERIAL_ID;
    walls.push({ c: wall.c, r: wall.r, material });
  }
  const fuels = [];
  for (const fuel of input.fuels.slice(0, MAX_FUELS)) {
    if (!plain(fuel) || !inGrid(fuel.c, fuel.r) || occupied.has(cellKey(fuel.c, fuel.r))) continue;
    occupied.add(cellKey(fuel.c, fuel.r));
    fuels.push({ c: fuel.c, r: fuel.r });
  }

  const run = input.run;
  const latestInput = plain(run.latest) ? run.latest : {};
  const latest = {};
  for (const key of Object.keys(TUTOR_METRICS)) latest[key] = finite(latestInput[key], -1e6, 1e6);
  const series = (Array.isArray(run.series) ? run.series : []).slice(-MAX_SERIES)
    .filter(plain)
    .map((point) => {
      const clean = { t: finite(point.t, 0, 1e6) };
      for (const key of SERIES_METRICS) clean[key] = finite(point[key], -1e6, 1e6);
      clean.burning = point.burning === 1 ? 1 : 0;
      return clean;
    });

  return {
    version: TUTOR_CONTEXT_VERSION,
    grid: { cols: GRID_COLS, rows: GRID_ROWS, cell: BUILD_CELL },
    preset: typeof input.preset === 'string' && Object.hasOwn(STOVE_PRESETS, input.preset) ? input.preset : 'custom',
    edited: input.edited === true,
    walls,
    fuels,
    run: {
      ignited: run.ignited === true,
      time: finite(run.time, 0, 1e6),
      startTime: Math.min(finite(run.startTime, 0, 1e6), finite(run.time, 0, 1e6)),
      backend: BACKENDS.has(run.backend) ? run.backend : 'cpu',
      fuelPhase: FUEL_PHASES.has(run.fuelPhase) ? run.fuelPhase : 'unlit',
      reactiveFuel: finite(run.reactiveFuel, 0, 1e6),
      latest,
      series,
    },
  };
}

export function sanitizeQuestion(value) {
  if (typeof value !== 'string') throw new Error('INVALID_QUESTION');
  const question = value.trim();
  if (!question || question.length > MAX_QUESTION_LENGTH) throw new Error('INVALID_QUESTION');
  return question;
}

/** Recent conversation turns for the model; anything malformed is dropped. */
export function sanitizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((turn) => plain(turn) && (turn.role === 'student' || turn.role === 'tutor') &&
      typeof turn.text === 'string' && turn.text.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({ role: turn.role, text: turn.text.trim().slice(0, MAX_HISTORY_TEXT) }));
}

const MATERIAL_GLYPHS = Object.freeze({ insulating: 'I', standard: '#', conductive: 'K' });

/** Text picture of the stove for a language model: rows top to bottom. */
export function asciiStoveMap(context) {
  const rows = Array.from({ length: context.grid.rows }, () => Array(context.grid.cols).fill('.'));
  for (const wall of context.walls) rows[wall.r][wall.c] = MATERIAL_GLYPHS[wall.material] ?? '#';
  for (const fuel of context.fuels) rows[fuel.r][fuel.c] = 'F';
  const legend = 'legend: .=air #=standard brick I=insulating brick K=conductive brick F=straw fuel; row 0 is the top';
  return [legend, ...rows.map((row) => row.join(''))].join('\n');
}

/** Cells a reply may point at: walls, fuel, and the air cells right next to them (openings). */
export function groundableCells(context) {
  const allowed = new Set();
  for (const item of [...context.walls, ...context.fuels]) {
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (inGrid(item.c + dc, item.r + dr)) allowed.add(cellKey(item.c + dc, item.r + dr));
      }
    }
  }
  return allowed;
}

const METRIC_KEY_PATTERN = new RegExp(
  `[ \\t]?(?<![A-Za-z0-9_])(${[...Object.keys(TUTOR_METRICS), ...Object.keys(WALL_MATERIALS)].join('|')})(?![A-Za-z0-9_])[ \\t]?`,
  'g',
);

function cleanText(value) {
  if (typeof value !== 'string') return '';
  // Internal field names are replaced by the on-screen label so students only
  // see words that exist in the interface.
  return value
    .replace(METRIC_KEY_PATTERN, (_match, key) => (Object.hasOwn(TUTOR_METRICS, key) ? `「${TUTOR_METRICS[key]}」` : `「${WALL_MATERIALS[key].label}」`))
    .trim()
    .slice(0, MAX_TEXT);
}

/**
 * Keep only references that exist in this context. A reply with no usable
 * guidance is rejected instead of being shown half-empty.
 */
export function groundTutorReply(reply, context) {
  if (!plain(reply)) throw new Error('INVALID_REPLY');
  const guidance = cleanText(reply.guidance);
  const question = cleanText(reply.question);
  if (!guidance || !question) throw new Error('INVALID_REPLY');

  const allowed = groundableCells(context);
  const seenCells = new Set();
  const relatedCells = [];
  for (const cell of Array.isArray(reply.relatedCells) ? reply.relatedCells : []) {
    if (relatedCells.length >= MAX_RELATED) break;
    if (!plain(cell) || !allowed.has(cellKey(cell.c, cell.r)) || seenCells.has(cellKey(cell.c, cell.r))) continue;
    seenCells.add(cellKey(cell.c, cell.r));
    relatedCells.push({ c: cell.c, r: cell.r });
  }
  const relatedMetrics = [...new Set((Array.isArray(reply.relatedMetrics) ? reply.relatedMetrics : [])
    .filter((key) => typeof key === 'string' && Object.hasOwn(TUTOR_METRICS, key)))]
    .slice(0, MAX_RELATED);

  return { guidance, question, relatedCells, relatedMetrics };
}
