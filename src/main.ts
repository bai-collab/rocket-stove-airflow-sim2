import './style.css';
import {
  AMBIENT_T,
  DT,
  H,
  NX,
  NY,
  SIM_HEIGHT,
  SIM_WIDTH,
} from './simulation/CpuRocketSimulation.mjs';
import {
  BrowserSimulationController,
  type BackendPreference,
  type BackendStatus,
} from './simulation/BrowserSimulationController';
import { BUILD_CELL, STOVE_PRESETS } from './simulation/presets.mjs';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <main class="app-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Physics v3 · Phase 4</p>
        <h1>火箭爐空氣流動與稻稈碳化模擬器</h1>
        <p>設計 → 點火 → 觀察氣流／黑煙／碳化 → 修改 → 再測試</p>
      </div>
      <div id="backend-status" class="status-pill">正在偵測運算後端…</div>
    </header>

    <section class="workspace">
      <aside class="panel tools">
        <h2>1. 建造火箭爐</h2>
        <div class="tool-grid" id="tool-grid">
          <button class="tool active" data-tool="wall">磚塊／爐壁</button>
          <button class="tool" data-tool="fuel">稻稈燃料</button>
          <button class="tool" data-tool="erase">橡皮擦</button>
        </div>
        <p class="hint">爐壁留下的開口就是自然進排氣通道。藍色粒子只是氣流示蹤，不是氧氣分子。</p>

        <h2>2. 測試</h2>
        <div class="action-stack">
          <button id="ignite" class="primary">🔥 點火</button>
          <button id="pause">暫停</button>
          <button id="reset">重新載入爐型</button>
          <button id="clear">全部清除</button>
        </div>

        <div class="backend-control">
          <label for="backend-select">運算後端</label>
          <select id="backend-select">
            <option value="auto">自動（推薦）</option>
            <option value="cpu">CPU · Physics v3</option>
            <option value="gpu">GPU · VGPU/WebGPU</option>
          </select>
          <p id="backend-detail" class="backend-detail">偵測 WebGPU 中…</p>
        </div>

        <label class="range-label" for="speed">模擬速度 <output id="speed-value">1×</output></label>
        <input id="speed" type="range" min="1" max="4" step="1" value="1" />

        <div class="legend">
          <span><i class="dot air"></i>藍：空氣 tracer</span>
          <span><i class="dot heat"></i>橘：高溫區</span>
          <span><i class="dot smoke"></i>黑灰：相對黑煙</span>
          <span><i class="box fuel"></i>黃褐→黑：稻稈→炭</span>
          <span><i class="box wall"></i>磚牆</span>
        </div>
      </aside>

      <section class="simulation-card">
        <canvas id="sim-canvas" width="${SIM_WIDTH}" height="${SIM_HEIGHT}" aria-label="火箭爐二維氣流與燃料轉化模擬"></canvas>
        <div class="preset-panel">
          <h2>快速爐型</h2>
          <div id="preset-grid" class="preset-grid"></div>
          <p id="preset-description" class="hint"></p>
        </div>
        <p class="model-note">Physics v3：稻稈是有限燃料。受熱後先熱裂解成揮發性氣體與炭；黑煙只有在高溫、含氧、充分混合並具有停留時間時才可進一步氧化。灰分來自燃料原有礦物質留下，不代表「碳變成灰」。Phase 4 的 GPU 模式已把熱裂解、揮發氣燃燒、炭氧化、氣流與標量傳輸、冷卻、二次燃燒及開放邊界交換搬到 VGPU/WebGPU；CPU 目前同步結果供診斷、Canvas2D 與 tracer 使用。</p>
      </section>

      <aside class="panel metrics-panel">
        <h2>3. 觀察結果</h2>
        <div id="metrics" class="metrics"></div>
        <details open>
          <summary>進階診斷</summary>
          <div id="advanced" class="metrics advanced"></div>
        </details>
        <div id="feedback" class="feedback"></div>
      </aside>
    </section>
  </main>
`;

const canvas = document.querySelector<HTMLCanvasElement>('#sim-canvas')!;
const ctx = canvas.getContext('2d')!;
const metrics = document.querySelector<HTMLDivElement>('#metrics')!;
const advanced = document.querySelector<HTMLDivElement>('#advanced')!;
const feedback = document.querySelector<HTMLDivElement>('#feedback')!;
const presetGrid = document.querySelector<HTMLDivElement>('#preset-grid')!;
const presetDescription = document.querySelector<HTMLParagraphElement>('#preset-description')!;
const igniteButton = document.querySelector<HTMLButtonElement>('#ignite')!;
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!;
const resetButton = document.querySelector<HTMLButtonElement>('#reset')!;
const clearButton = document.querySelector<HTMLButtonElement>('#clear')!;
const speedInput = document.querySelector<HTMLInputElement>('#speed')!;
const speedValue = document.querySelector<HTMLOutputElement>('#speed-value')!;
const backendSelect = document.querySelector<HTMLSelectElement>('#backend-select')!;
const backendStatus = document.querySelector<HTMLDivElement>('#backend-status')!;
const backendDetail = document.querySelector<HTMLParagraphElement>('#backend-detail')!;

const controller = new BrowserSimulationController();
const sim = controller.cpu;
let selectedTool = 'wall';
let selectedPreset = 'straight';
let drawing = false;
let lastFrame = performance.now();
let accumulator = 0;
let physicsBusy = false;

function isBackendPreference(value: string | null): value is BackendPreference {
  return value === 'auto' || value === 'cpu' || value === 'gpu';
}

function renderBackendStatus(status: BackendStatus) {
  backendStatus.textContent = `${status.label}${status.fallback ? ' · fallback' : ''}`;
  backendStatus.classList.toggle('gpu', status.effective === 'gpu');
  backendStatus.classList.toggle('fallback', status.fallback);
  backendDetail.textContent = status.detail;
}

controller.subscribe(renderBackendStatus);

function metric(label: string, value: string) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function interpret(d: ReturnType<typeof sim.diagnostics>) {
  if (!sim.ignited) return '先按「點火」，再觀察高溫煙氣是否能建立自然上升流。';
  if (d.pyrolysisFraction < 0.08 && d.time > 3) return '稻稈熱裂解仍低：可檢查燃料是否被爐體阻隔、或高溫區是否建立。';
  if (d.fuelOxygen < 0.16 && d.charRetention > 0.65) return '目前偏碳化／保炭：燃料附近缺氧，生成的炭較多被保留下來。';
  if (d.smoke > 0.08 && d.secondaryRate < 0.001) return '目前偏不完全燃燒：黑煙較多，但二次燃燒條件不足。';
  if (d.smokeOut > 0.02 && d.secondaryRate > 0) return '已有二次燃燒，但仍有黑煙排出；可調整煙道、混合區或開口位置。';
  if (d.charRetention < 0.35 && d.smoke < 0.03) return '目前較偏充分燃燒：黑煙低、生成炭也持續氧化。';
  return '目前介於燃燒與碳化之間；比較不同爐型的氧氣、黑煙排出與炭保留率。';
}

function renderMetrics() {
  const d = sim.diagnostics();
  metrics.innerHTML = [
    metric('平均氣流速度', `${d.averageSpeed.toFixed(1)} px/s`),
    metric('燃料區相對氧氣', `${(d.fuelOxygen * 100).toFixed(0)}%`),
    metric('相對黑煙量', d.smoke.toFixed(3)),
    metric('黑煙排出累積', d.smokeOut.toFixed(3)),
    metric('熱裂解比例', `${(d.pyrolysisFraction * 100).toFixed(1)}%`),
    metric('炭保留率', `${(d.charRetention * 100).toFixed(1)}%`),
    metric('碳化指標', d.carbonizationIndex.toFixed(1)),
    metric('剩餘稻稈', d.rawStraw.toFixed(3)),
    metric('剩餘炭', d.char.toFixed(3)),
    metric('灰分顯現', d.ash.toFixed(3)),
  ].join('');

  advanced.innerHTML = [
    metric('運算後端', controller.status.effective.toUpperCase()),
    metric('二次燃燒速率', d.secondaryRate.toExponential(2)),
    metric('壓力投影殘差', d.pressureResidual.toExponential(2)),
    metric('邊界進流', d.inflow.toFixed(2)),
    metric('邊界出流', d.outflow.toFixed(2)),
    metric('未燃揮發氣體', d.volatileGas.toFixed(3)),
    metric('平均溫度', `${d.averageTemperature.toFixed(1)} °C`),
    metric('有機守恆誤差', d.organicError.toExponential(2)),
    metric('礦物守恆誤差', d.mineralError.toExponential(2)),
  ].join('');
  feedback.textContent = interpret(d);
}

function drawField() {
  ctx.clearRect(0, 0, SIM_WIDTH, SIM_HEIGHT);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, SIM_WIDTH, SIM_HEIGHT);

  for (let gy = 0; gy < NY; gy += 1) {
    for (let gx = 0; gx < NX; gx += 1) {
      const i = gy * NX + gx;
      if (sim.solid[i]) continue;
      const temp = sim.temperature[i];
      if (temp > AMBIENT_T + 8) {
        const t = Math.min(1, (temp - AMBIENT_T) / 450);
        ctx.fillStyle = `rgba(245, 112, 38, ${0.04 + t * 0.30})`;
        ctx.fillRect(gx * H, gy * H, H + 1, H + 1);
      }
      const smoke = sim.smoke[i];
      if (smoke > 0.0003) {
        const alpha = Math.min(0.62, smoke * 3.4);
        ctx.fillStyle = `rgba(25, 28, 33, ${alpha})`;
        ctx.fillRect(gx * H, gy * H, H + 1, H + 1);
      }
    }
  }

  ctx.strokeStyle = 'rgba(71, 85, 105, 0.22)';
  ctx.lineWidth = 1;
  for (let y = 0; y < SIM_HEIGHT; y += BUILD_CELL) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(SIM_WIDTH, y + 0.5);
    ctx.stroke();
  }
  for (let x = 0; x < SIM_WIDTH; x += BUILD_CELL) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, SIM_HEIGHT);
    ctx.stroke();
  }

  for (let gy = 2; gy < NY; gy += 4) {
    for (let gx = 2; gx < NX; gx += 4) {
      const i = gy * NX + gx;
      if (sim.solid[i]) continue;
      const u = sim.u[i];
      const v = sim.v[i];
      const speed = Math.hypot(u, v);
      if (speed < 2) continue;
      const scale = Math.min(12, 2 + speed * 0.18) / speed;
      const x = (gx + 0.5) * H;
      const y = (gy + 0.5) * H;
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.30)';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + u * scale, y + v * scale);
      ctx.stroke();
    }
  }

  for (const p of sim.tracers) {
    const temp = sim.sampleField(sim.temperature, p.x, p.y, AMBIENT_T);
    ctx.fillStyle = temp > 100 ? 'rgba(249, 115, 22, 0.78)' : 'rgba(37, 99, 235, 0.70)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const wall of sim.walls) {
    ctx.fillStyle = '#8b5e3c';
    ctx.fillRect(wall.x + 1, wall.y + 1, BUILD_CELL - 2, BUILD_CELL - 2);
    ctx.strokeStyle = '#5f3f29';
    ctx.strokeRect(wall.x + 1.5, wall.y + 1.5, BUILD_CELL - 3, BUILD_CELL - 3);
  }

  for (const fuel of sim.fuels) {
    const gx0 = Math.floor(fuel.x / H);
    const gy0 = Math.floor(fuel.y / H);
    let raw = 0;
    let char = 0;
    let ash = 0;
    for (let gy = gy0; gy < Math.min(NY, gy0 + 2); gy += 1) {
      for (let gx = gx0; gx < Math.min(NX, gx0 + 2); gx += 1) {
        const i = gy * NX + gx;
        raw += sim.rawStraw[i];
        char += sim.char[i];
        ash += sim.ash[i];
      }
    }
    const total = raw + char + ash;
    const charRatio = total > 1e-6 ? char / total : 0;
    const ashRatio = total > 1e-6 ? ash / total : 0;
    const light = Math.max(16, 54 - charRatio * 34 + ashRatio * 20);
    ctx.fillStyle = `hsl(30 45% ${light}%)`;
    ctx.fillRect(fuel.x + 3, fuel.y + 3, BUILD_CELL - 6, BUILD_CELL - 6);
    ctx.strokeStyle = '#3f2a1d';
    ctx.strokeRect(fuel.x + 3.5, fuel.y + 3.5, BUILD_CELL - 7, BUILD_CELL - 7);
  }
}

function canvasPoint(event: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * SIM_WIDTH / rect.width,
    y: (event.clientY - rect.top) * SIM_HEIGHT / rect.height,
  };
}

function applyTool(event: PointerEvent) {
  const p = canvasPoint(event);
  controller.setToolAt(selectedTool, p.x, p.y);
  drawField();
  renderMetrics();
}

canvas.addEventListener('pointerdown', (event) => {
  drawing = true;
  canvas.setPointerCapture(event.pointerId);
  applyTool(event);
});
canvas.addEventListener('pointermove', (event) => {
  if (drawing) applyTool(event);
});
canvas.addEventListener('pointerup', () => { drawing = false; });
canvas.addEventListener('pointercancel', () => { drawing = false; });

document.querySelector('#tool-grid')!.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tool]');
  if (!button?.dataset.tool) return;
  selectedTool = button.dataset.tool;
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((item) => {
    item.classList.toggle('active', item === button);
  });
});

presetGrid.innerHTML = Object.entries(STOVE_PRESETS)
  .map(([id, preset]) => `<button data-preset="${id}"><strong>${preset.label}</strong><small>${preset.description}</small></button>`)
  .join('');

function loadPreset(id: string) {
  if (!controller.loadPreset(id)) return;
  selectedPreset = id;
  const preset = STOVE_PRESETS[id as keyof typeof STOVE_PRESETS];
  presetDescription.textContent = preset.description;
  presetGrid.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
    button.classList.toggle('active', button.dataset.preset === id);
  });
  pauseButton.textContent = '暫停';
  accumulator = 0;
  drawField();
  renderMetrics();
}

presetGrid.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-preset]');
  if (button?.dataset.preset) loadPreset(button.dataset.preset);
});

igniteButton.addEventListener('click', () => controller.ignite());
pauseButton.addEventListener('click', () => {
  controller.pause();
  pauseButton.textContent = sim.running ? '暫停' : '繼續';
});
resetButton.addEventListener('click', () => loadPreset(selectedPreset));
clearButton.addEventListener('click', () => {
  controller.clearScene();
  accumulator = 0;
  drawField();
  renderMetrics();
});
speedInput.addEventListener('input', () => {
  speedValue.value = `${speedInput.value}×`;
});

backendSelect.addEventListener('change', async () => {
  const preference = backendSelect.value;
  if (!isBackendPreference(preference)) return;
  backendSelect.disabled = true;
  try {
    localStorage.setItem('rocket-stove-backend', preference);
    await controller.setBackend(preference);
    accumulator = 0;
  } finally {
    backendSelect.disabled = false;
  }
});

async function advancePhysics() {
  if (physicsBusy) return;
  physicsBusy = true;
  try {
    let guard = 0;
    while (accumulator >= DT && guard < 2) {
      await controller.step(DT);
      accumulator -= DT;
      guard += 1;
    }
  } finally {
    physicsBusy = false;
  }
}

function frame(now: number) {
  const elapsed = Math.min(0.08, (now - lastFrame) / 1000);
  lastFrame = now;
  accumulator = Math.min(DT * 6, accumulator + elapsed * Number(speedInput.value));
  void advancePhysics();
  drawField();
  renderMetrics();
  requestAnimationFrame(frame);
}

const storedBackend = localStorage.getItem('rocket-stove-backend');
const initialBackend: BackendPreference = isBackendPreference(storedBackend) ? storedBackend : 'auto';
backendSelect.value = initialBackend;
loadPreset(selectedPreset);
await controller.initialize(initialBackend);
requestAnimationFrame(frame);

window.addEventListener('beforeunload', () => controller.dispose());
