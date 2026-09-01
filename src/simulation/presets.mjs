export const BUILD_CELL = 24;

function cell(c, r) {
  return { x: c * BUILD_CELL, y: r * BUILD_CELL };
}

function buildWalls(builder) {
  const cells = new Map();
  const add = (c, r) => cells.set(`${c},${r}`, cell(c, r));
  const vertical = (c, from, to, gaps = []) => {
    for (let r = from; r <= to; r += 1) if (!gaps.includes(r)) add(c, r);
  };
  const horizontal = (r, from, to, gaps = []) => {
    for (let c = from; c <= to; c += 1) if (!gaps.includes(c)) add(c, r);
  };
  builder({ add, vertical, horizontal });
  return [...cells.values()];
}

export const STOVE_PRESETS = {
  straight: {
    label: 'A 垂直升火筒',
    description: '較直接的上升通道，觀察自然抽力與二次燃燒。',
    walls: buildWalls(({ vertical, horizontal }) => {
      vertical(12, 14, 21, [14]);
      vertical(24, 14, 21, [14]);
      horizontal(21, 12, 24);
      horizontal(18, 17, 19, [18]);
      vertical(17, 18, 20);
      vertical(19, 18, 20);
      vertical(16, 9, 16, [12, 14]);
      vertical(20, 9, 16, [12, 14]);
      vertical(14, 3, 9);
      vertical(22, 3, 9);
      horizontal(9, 14, 22, [17, 18, 19]);
    }),
    fuels: [cell(18, 20)],
  },

  baffle: {
    label: 'B Z 型折流爐',
    description: '延長高溫氣體路徑，觀察混合與停留時間。',
    walls: buildWalls(({ vertical, horizontal }) => {
      vertical(11, 14, 21, [14]);
      vertical(25, 3, 21, [14]);
      horizontal(21, 11, 25, [15]);
      horizontal(17, 11, 24, [23, 24]);
      horizontal(13, 12, 24, [12, 13]);
      horizontal(9, 12, 22, [21, 22]);
      vertical(21, 3, 8);
    }),
    fuels: [cell(15, 19)],
  },

  twinChannel: {
    label: 'C 雙通道預熱爐',
    description: '較複雜的雙通道結構，用來比較預熱、阻力與保炭。',
    walls: buildWalls(({ vertical, horizontal }) => {
      vertical(10, 14, 21, [14]);
      vertical(26, 14, 21, [14]);
      horizontal(21, 10, 26);
      horizontal(17, 10, 26, [16, 17, 18, 19, 20]);
      horizontal(18, 17, 19, [18]);
      vertical(17, 18, 20);
      vertical(19, 18, 20);
      vertical(14, 8, 16, [12, 15]);
      vertical(22, 8, 16, [12, 15]);
      vertical(17, 8, 16, [12, 15]);
      vertical(19, 8, 16, [12, 15]);
      horizontal(11, 14, 22, [16, 17, 18, 19, 20]);
      horizontal(8, 14, 22, [16, 17, 18, 19, 20]);
      vertical(14, 3, 8);
      vertical(22, 3, 8);
    }),
    fuels: [cell(18, 20)],
  },

  sealed: {
    label: 'D 完全封閉',
    description: '3×3 封閉 oracle：外圈 8 格爐壁包住 1 格稻稈，用來驗證密閉區不從外界補氧。',
    walls: buildWalls(({ add }) => {
      const cx = 18;
      const cy = 20;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          add(cx + dx, cy + dy);
        }
      }
    }),
    fuels: [cell(18, 20)],
  },
};
