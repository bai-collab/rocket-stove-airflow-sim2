/**
 * Rule-based one-line feedback shown under the metrics panel. Shared by the
 * browser UI and the local mock tutor so both describe the same situation.
 */
export function interpretDiagnostics(d, ignited) {
  if (!ignited) return '先按「點火」，再觀察高溫煙氣是否能建立自然上升流。';
  if (d.fuelPhase === 'extinguished') return '目前火焰已熄滅；檢查燃料區是否仍有足夠熱量與氧氣。';
  if (d.pyrolysisFraction < 0.08 && d.time > 3) return '稻稈熱裂解仍低：可檢查燃料是否被爐體阻隔、或高溫區是否建立。';
  if (d.fuelOxygen < 0.16 && d.charRetention > 0.65) return '目前偏碳化／保炭：燃料附近缺氧，生成的炭較多被保留下來。';
  if (d.smoke > 0.08 && d.secondaryRate < 0.001) return '目前偏不完全燃燒：黑煙較多，但二次燃燒條件不足。';
  if (d.smokeOut > 0.02 && d.secondaryRate > 0) return '已有二次燃燒，但仍有黑煙排出；可調整煙道、混合區或開口位置。';
  if (d.charRetention < 0.35 && d.smoke < 0.03) return '目前較偏充分燃燒：黑煙低、生成炭也持續氧化。';
  return '目前介於燃燒與碳化之間；比較不同爐型的氧氣、黑煙排出與炭保留率。';
}
