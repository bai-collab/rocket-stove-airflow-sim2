import { getWallMaterial } from '../physics/wall-materials.mjs';

/**
 * Local rule-based tutor. It never calls a model: it reads the sanitized stove
 * context, picks one small next step and one follow-up question, and points at
 * cells/metrics that actually exist. It does not diagnose beyond these rules.
 */

const distance = (a, b) => Math.abs(a.c - b.c) + Math.abs(a.r - b.r);

function nearestFuel(context) {
  return context.fuels[0] ?? null;
}

function wallsNearFuel(context, predicate, limit) {
  const fuel = nearestFuel(context);
  if (!fuel) return [];
  return context.walls
    .filter(predicate)
    .sort((a, b) => distance(a, fuel) - distance(b, fuel))
    .slice(0, limit)
    .map(({ c, r }) => ({ c, r }));
}

/** Top-most wall cells closest to the fuel column: the usual exhaust region. */
function exitCells(context) {
  if (!context.walls.length) return [];
  const topRow = Math.min(...context.walls.map((w) => w.r));
  const fuelColumn = nearestFuel(context)?.c ?? context.grid.cols / 2;
  return context.walls
    .filter((w) => w.r === topRow)
    .sort((a, b) => Math.abs(a.c - fuelColumn) - Math.abs(b.c - fuelColumn))
    .slice(0, 2)
    .map(({ c, r }) => ({ c, r }));
}

function fuelCells(context) {
  return context.fuels.slice(0, 1).map(({ c, r }) => ({ c, r }));
}

const TOPICS = {
  tracer: () => ({
    guidance: '藍色粒子只是用來看空氣怎麼流動的記號，不是氧氣；氧氣要看「燃料區相對氧氣」這個數字。',
    question: '粒子流到燃料旁邊的路線，和氧氣數字的變化有沒有一致？',
    relatedCells: [],
    relatedMetrics: ['averageSpeed', 'fuelOxygen'],
  }),
  oxygen: (context, prefix = '') => ({
    guidance: `${prefix}看「燃料區相對氧氣」：如果偏低，檢查稻稈旁邊有沒有讓新鮮空氣流進來的開口。`,
    question: '新鮮空氣會從哪一個開口流到稻稈旁邊？',
    relatedCells: fuelCells(context),
    relatedMetrics: ['fuelOxygen', 'averageSpeed'],
  }),
  smoke: (context, prefix = '') => ({
    guidance: `${prefix}黑煙不會只因為碰到空氣就消失，要在高溫、有氧、混合好並停留夠久的地方才會被燒掉；比較「相對黑煙量」和「二次燃燒速率」。`,
    question: '黑煙從燃料走到出口的路上，有沒有經過又熱又有空氣的地方？',
    relatedCells: exitCells(context),
    relatedMetrics: ['smoke', 'secondaryRate', 'smokeOut'],
  }),
  char: (context) => ({
    guidance: '看「炭保留率」：燃料附近氧氣少時，熱裂解產生的炭比較容易留下來，不會繼續燒掉。',
    question: '這次你想多留下炭，還是燒得乾淨、黑煙少？兩者要怎麼取捨？',
    relatedCells: fuelCells(context),
    relatedMetrics: ['charRetention', 'fuelOxygen', 'carbonizationIndex'],
  }),
  walls: (context) => {
    const conductive = wallsNearFuel(context, (w) => getWallMaterial(w.material).conductivity >= 1, 3);
    return {
      guidance: '比較「磚牆內側溫度」和「磚牆外側溫度」：外側越熱，代表熱越快被磚帶離燃燒區。',
      question: '如果把燃燒室旁邊的磚換成低導熱隔熱磚，你預測燃料區溫度會怎麼變？',
      relatedCells: conductive.length ? conductive : wallsNearFuel(context, () => true, 2),
      relatedMetrics: ['wallInnerTemperature', 'wallOuterTemperature', 'fuelTemperature'],
    };
  },
  pyrolysis: (context) => ({
    guidance: '「熱裂解比例」還很低：先看「燃料區溫度」有沒有升高，檢查稻稈是不是被磚擋住、熱氣流不到。',
    question: '點火後，熱氣是往稻稈的方向流，還是繞開了它？',
    relatedCells: fuelCells(context),
    relatedMetrics: ['pyrolysisFraction', 'fuelTemperature'],
  }),
};

function topicFromQuestion(question) {
  if (/藍色|粒子|示蹤|tracer/i.test(question)) return 'tracer';
  if (/氧|空氣|進氣|通風|吸/.test(question)) return 'oxygen';
  if (/煙/.test(question)) return 'smoke';
  if (/炭|碳/.test(question)) return 'char';
  if (/磚|保溫|導熱|隔熱|散熱/.test(question)) return 'walls';
  if (/熱裂解|點不著|不會燒|燒不起來/.test(question)) return 'pyrolysis';
  return null;
}

export function mockTutorReply(context, question = '') {
  const d = context.run.latest;

  if (!context.fuels.length) {
    return {
      guidance: '先選「稻稈燃料」，在燃燒室底部放一格稻稈。',
      question: '你打算把燃料放在爐子的哪個位置？為什麼？',
      relatedCells: [],
      relatedMetrics: [],
    };
  }
  if (!context.walls.length) {
    return {
      guidance: '先用「磚塊／爐壁」圍出燃燒室，再往上做一段煙道，也可以先載入一個快速爐型。',
      question: '你希望熱氣從燃料出發後，往哪個方向走？',
      relatedCells: fuelCells(context),
      relatedMetrics: [],
    };
  }

  const topic = topicFromQuestion(question);
  if (topic === 'tracer') return TOPICS.tracer(context);

  if (!context.run.ignited) {
    return {
      guidance: '先預測再點火：想一想熱氣和黑煙會往哪裡走，然後按「點火」觀察。',
      question: '點火後，你預測黑煙會從哪一個開口出去？',
      relatedCells: fuelCells(context),
      relatedMetrics: [],
    };
  }

  if (topic) return TOPICS[topic](context);

  if (context.run.fuelPhase === 'extinguished') {
    if (context.run.reactiveFuel > 0.001 && d.fuelOxygen < 0.06) {
      return TOPICS.oxygen(context, '火熄了，但燃料還在：');
    }
    return TOPICS.walls(context);
  }
  if (d.pyrolysisFraction < 0.08 && context.run.time > 3) return TOPICS.pyrolysis(context);
  if (d.fuelOxygen < 0.16 && d.charRetention > 0.65) return TOPICS.char(context);
  if (d.smoke > 0.08 && d.secondaryRate < 0.001) return TOPICS.smoke(context);
  if (d.smokeOut > 0.02 && d.secondaryRate > 0) return TOPICS.smoke(context, '已經有二次燃燒，但還有黑煙排出。');
  if (d.averageWallConductivity >= 1 && d.wallOuterTemperature > 60) return TOPICS.walls(context);
  if (d.charRetention < 0.35 && d.smoke < 0.03) {
    return {
      guidance: '目前黑煙低、炭也持續被燒掉，偏向充分燃燒；把這組數字記下來當作比較基準。',
      question: '換成另一種爐型時，你預測哪一個數字會最先改變？',
      relatedCells: [],
      relatedMetrics: ['smoke', 'charRetention'],
    };
  }
  return {
    guidance: '目前介於燃燒和碳化之間；先記下「燃料區相對氧氣」、「黑煙排出累積」和「炭保留率」，再換一個爐型比較。',
    question: '這三個數字裡，你最想改善哪一個？要改爐子的哪裡？',
    relatedCells: [],
    relatedMetrics: ['fuelOxygen', 'smokeOut', 'charRetention'],
  };
}
