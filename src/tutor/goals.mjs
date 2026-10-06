/**
 * Class design goals the teacher can set, and the run summary used by test
 * records. Summaries describe the relative teaching model only; they are
 * not scores and are never produced by the AI.
 */
export const CLASS_GOALS = Object.freeze({
  free: Object.freeze({ id: 'free', label: '自由探索', hint: '比較不同爐型的氧氣、黑煙與炭保留。', focus: [] }),
  lowSmoke: Object.freeze({
    id: 'lowSmoke', label: '低黑煙', hint: '讓排出的黑煙越少越好。',
    focus: ['smokeOut', 'smoke', 'secondaryRate'],
  }),
  keepChar: Object.freeze({
    id: 'keepChar', label: '多留炭', hint: '讓熱裂解產生的炭盡量留下來。',
    focus: ['charRetention', 'carbonizationIndex', 'fuelOxygen'],
  }),
  stableBurn: Object.freeze({
    id: 'stableBurn', label: '穩定燃燒', hint: '點火後持續燃燒、不要熄火。',
    focus: ['fuelTemperature', 'fuelOxygen', 'pyrolysisFraction'],
  }),
});

export const DEFAULT_GOAL = 'free';

export function normalizeGoal(value) {
  return typeof value === 'string' && Object.hasOwn(CLASS_GOALS, value) ? value : DEFAULT_GOAL;
}

const round = (value, digits = 4) => Number(value.toFixed(digits));

/** Summary of one test segment from a sanitized stove context. */
export function summarizeRun(context) {
  const { run } = context;
  const series = run.series.filter((point) => point.t >= run.startTime);
  const latest = run.latest;
  const values = (key) => [...series.map((point) => point[key]), latest[key]];
  const burningSamples = series.filter((point) => point.burning === 1).length;
  return {
    durationSec: round(Math.max(0, run.time - run.startTime), 1),
    samples: series.length,
    finalPhase: run.fuelPhase,
    burnFraction: series.length ? round(burningSamples / series.length, 3) : 0,
    peakFuelTemperature: round(Math.max(...values('fuelTemperature')), 1),
    averageFuelOxygen: round(values('fuelOxygen').reduce((sum, v) => sum + v, 0) / values('fuelOxygen').length, 3),
    peakSmoke: round(Math.max(...values('smoke'))),
    smokeOut: round(latest.smokeOut),
    secondaryObserved: values('secondaryRate').some((v) => v > 0),
    charRetention: round(latest.charRetention, 3),
    carbonizationIndex: round(latest.carbonizationIndex, 2),
    pyrolysisFraction: round(latest.pyrolysisFraction, 3),
  };
}
