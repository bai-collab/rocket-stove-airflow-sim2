import './style.css';
import {
  createFuelState,
  fuelDiagnostics,
  stepFuelModel,
} from './physics/fuel-model.mjs';

type Preset = {
  label: string;
  temperature: number;
  oxygen: number;
  mixing: number;
  residenceTime: number;
};

const presets: Record<string, Preset> = {
  carbonization: {
    label: '高溫缺氧／碳化',
    temperature: 500,
    oxygen: 0.08,
    mixing: 0.35,
    residenceTime: 0.2,
  },
  clean: {
    label: '高溫富氧／較充分燃燒',
    temperature: 560,
    oxygen: 1,
    mixing: 0.9,
    residenceTime: 1,
  },
  smoky: {
    label: '低溫缺氧／不完全燃燒',
    temperature: 260,
    oxygen: 0.12,
    mixing: 0.2,
    residenceTime: 0.1,
  },
  secondary: {
    label: '高溫＋混合＋停留／二次燃燒',
    temperature: 650,
    oxygen: 1,
    mixing: 1,
    residenceTime: 1,
  },
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <section class="shell">
    <header>
      <div>
        <p class="eyebrow">Physics v3 CPU reference</p>
        <h1>稻稈燃料轉化實驗室</h1>
        <p class="lede">先驗證「稻稈 → 熱裂解 → 揮發氣體 + 炭 → 燃燒／碳化」因果鏈，再接回完整火箭爐氣流場。</p>
      </div>
      <div class="status-pill">CPU reference</div>
    </header>

    <section class="preset-row" id="presets"></section>

    <section class="grid-layout">
      <article class="panel controls">
        <h2>環境條件</h2>
        <label>溫度 <output id="temperature-out"></output>
          <input id="temperature" type="range" min="25" max="700" step="5" />
        </label>
        <label>初始氧氣 <output id="oxygen-out"></output>
          <input id="oxygen" type="range" min="0" max="1" step="0.01" />
        </label>
        <label>混合程度 <output id="mixing-out"></output>
          <input id="mixing" type="range" min="0" max="1" step="0.01" />
        </label>
        <label>停留時間 <output id="residence-out"></output>
          <input id="residence" type="range" min="0" max="1.5" step="0.05" />
        </label>

        <div class="button-row">
          <button id="toggle" class="primary">開始</button>
          <button id="reset">重設</button>
        </div>

        <p class="note">此頁只測試燃料轉化核心；完整二維 airflow、開放／封閉區與 tracer 會在 Phase 2 接回。</p>
      </article>

      <article class="panel">
        <div class="panel-title-row">
          <h2>燃料狀態</h2>
          <span id="time">0.0 s</span>
        </div>
        <div id="bars" class="bars"></div>
      </article>

      <article class="panel metrics-panel">
        <h2>教學指標</h2>
        <div id="metrics" class="metrics"></div>
      </article>

      <article class="panel explanation-panel">
        <h2>目前判讀</h2>
        <p id="interpretation"></p>
        <div class="reaction-chain">
          稻稈 → 熱裂解 → <strong>炭</strong> + <strong>揮發性氣體</strong> → 完全／不完全燃燒
        </div>
      </article>
    </section>
  </section>
`;

const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
const output = (id: string) => document.querySelector<HTMLOutputElement>(`#${id}`)!;

const temperatureInput = input('temperature');
const oxygenInput = input('oxygen');
const mixingInput = input('mixing');
const residenceInput = input('residence');
const toggleButton = document.querySelector<HTMLButtonElement>('#toggle')!;
const resetButton = document.querySelector<HTMLButtonElement>('#reset')!;
const bars = document.querySelector<HTMLDivElement>('#bars')!;
const metrics = document.querySelector<HTMLDivElement>('#metrics')!;
const interpretation = document.querySelector<HTMLParagraphElement>('#interpretation')!;
const timeOutput = document.querySelector<HTMLSpanElement>('#time')!;

let selectedPreset = 'carbonization';
let running = false;
let simulationTime = 0;
let state = createFuelState();

function numeric(el: HTMLInputElement) {
  return Number(el.value);
}

function setPreset(key: string) {
  const preset = presets[key];
  selectedPreset = key;
  temperatureInput.value = String(preset.temperature);
  oxygenInput.value = String(preset.oxygen);
  mixingInput.value = String(preset.mixing);
  residenceInput.value = String(preset.residenceTime);
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
    button.classList.toggle('active', button.dataset.preset === key);
  });
  resetSimulation();
}

function resetSimulation() {
  running = false;
  simulationTime = 0;
  state = createFuelState({
    temperature: numeric(temperatureInput),
    oxygen: numeric(oxygenInput),
    rawStraw: 1,
    mineralMatter: 0.12,
  });
  toggleButton.textContent = '開始';
  render();
}

function bar(label: string, value: number, max = 1) {
  const ratio = Math.max(0, Math.min(1, value / Math.max(max, 1e-6)));
  return `
    <div class="bar-row">
      <div class="bar-label"><span>${label}</span><strong>${value.toFixed(3)}</strong></div>
      <div class="bar-track"><div class="bar-fill" style="width:${ratio * 100}%"></div></div>
    </div>
  `;
}

function metric(label: string, value: string) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function classify(d: ReturnType<typeof fuelDiagnostics>) {
  if (d.pyrolysisFraction < 0.15) return '目前主要是加熱不足：多數稻稈尚未完成熱裂解。';
  if (d.charRetention > 0.65 && state.char > 0.08) return '目前偏向碳化／保炭：稻稈已明顯熱裂解，但生成的炭仍大量保留。';
  if (state.smoke > 0.08 || state.volatileGas > 0.08) return '目前偏向不完全燃燒：仍有較多黑煙或未燃揮發氣體。';
  if (d.charRetention < 0.3 && state.smoke < 0.03) return '目前偏向較充分燃燒：炭保留低、黑煙也相對低。';
  return '目前介於碳化與燃燒之間，可改變氧氣、溫度、混合或停留時間繼續比較。';
}

function render() {
  output('temperature-out').value = `${numeric(temperatureInput).toFixed(0)} °C`;
  output('oxygen-out').value = numeric(oxygenInput).toFixed(2);
  output('mixing-out').value = numeric(mixingInput).toFixed(2);
  output('residence-out').value = `${numeric(residenceInput).toFixed(2)} s`;
  timeOutput.textContent = `${simulationTime.toFixed(1)} s`;

  const d = fuelDiagnostics(state, { rawStraw: 1, mineralMatter: 0.12 });

  bars.innerHTML = [
    bar('剩餘稻稈', state.rawStraw),
    bar('炭', state.char),
    bar('揮發性氣體', state.volatileGas),
    bar('相對黑煙', state.smoke),
    bar('灰分', state.ash, 0.12),
    bar('剩餘氧氣', state.oxygen),
  ].join('');

  metrics.innerHTML = [
    metric('熱裂解比例', `${(d.pyrolysisFraction * 100).toFixed(1)}%`),
    metric('炭保留率', `${(d.charRetention * 100).toFixed(1)}%`),
    metric('碳化指標', d.carbonizationIndex.toFixed(1)),
    metric('累積形成炭', state.charGeneratedTotal.toFixed(3)),
    metric('已氧化炭', state.charBurnedTotal.toFixed(3)),
    metric('累積產煙', state.smokeGeneratedTotal.toFixed(3)),
    metric('二次氧化煙', state.smokeOxidizedTotal.toFixed(3)),
    metric('有機物守恆誤差', d.organicError.toExponential(2)),
    metric('礦物質守恆誤差', d.mineralError.toExponential(2)),
  ].join('');

  interpretation.textContent = classify(d);
}

function tick() {
  if (running) {
    const dt = 0.02;
    const stepsPerFrame = 4;
    for (let i = 0; i < stepsPerFrame; i += 1) {
      // The mini-lab treats the temperature slider as an external heater set-point.
      // Full airflow/thermal coupling will replace this controlled condition in Phase 2.
      state.temperature = numeric(temperatureInput);
      stepFuelModel(state, dt, {
        mixing: numeric(mixingInput),
        residenceTime: numeric(residenceInput),
      });
      simulationTime += dt;
    }
    render();
  }
  requestAnimationFrame(tick);
}

const presetContainer = document.querySelector<HTMLDivElement>('#presets')!;
presetContainer.innerHTML = Object.entries(presets)
  .map(([key, preset]) => `<button data-preset="${key}">${preset.label}</button>`)
  .join('');
presetContainer.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-preset]');
  if (button?.dataset.preset) setPreset(button.dataset.preset);
});

for (const el of [temperatureInput, oxygenInput, mixingInput, residenceInput]) {
  el.addEventListener('input', render);
}

toggleButton.addEventListener('click', () => {
  running = !running;
  toggleButton.textContent = running ? '暫停' : '繼續';
});
resetButton.addEventListener('click', resetSimulation);

setPreset(selectedPreset);
requestAnimationFrame(tick);
