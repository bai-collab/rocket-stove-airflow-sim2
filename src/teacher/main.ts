import './teacher.css';
import { CLASS_GOALS } from '../tutor/goals.mjs';
import { renderWorkspace } from './workspace';

type TeacherState = { initialized: boolean; aiConfigured: boolean; goal: string; loggedIn: boolean };

const PASSWORD_MIN = 12;
const app = document.querySelector<HTMLElement>('#teacher-app')!;

app.innerHTML = `
  <header class="teacher-header">
    <p class="eyebrow">火箭爐設計導師</p>
    <h1>教師工作台</h1>
    <p>查看學生的測試與提問紀錄、做 AI 分析，並設定本課目標與 NMKING AI 金鑰。金鑰只保存在這台電腦，學生端看不到。</p>
  </header>
  <section class="teacher-card" aria-live="polite">
    <div id="teacher-status" class="teacher-status">正在連線本機導師服務…</div>
    <p id="teacher-message" class="teacher-message" role="status"></p>
    <div id="teacher-view"></div>
  </section>
  <section class="teacher-card teacher-info">
    <h2>學生使用「真實模型」時會送出什麼</h2>
    <ul>
      <li>目前的爐型（磚塊位置與材料、稻稈位置）、觀察數據與最近的數據變化。</li>
      <li>學生輸入的問題，以及同一次對話中最近幾輪的問答。</li>
      <li>不會送出姓名、帳號或這台電腦上的其他檔案。</li>
    </ul>
    <p>每次提問只呼叫一次 AI，不會自動重試；本機服務每分鐘最多受理 6 次 AI 提問（可用環境變數 <code>TUTOR_AI_PER_MINUTE</code> 調整）。費用與額度以 NMKING 公告為準。</p>
    <p>金鑰取得：<a href="https://ai.nmking.io" target="_blank" rel="noopener noreferrer">NMKING 平台</a>、<a href="https://ai.nmking.io/trial" target="_blank" rel="noopener noreferrer">試用申請</a>。</p>
    <p class="teacher-warning">金鑰以明文保存在專案的 <code>local-data/</code> 資料夾：能操作這台電腦檔案的人仍可能取出。不要把這個資料夾複製給學生或上傳 GitHub。</p>
  </section>
  <p class="teacher-back"><a href="/">← 回到模擬器</a></p>
`;

const statusBox = document.querySelector<HTMLDivElement>('#teacher-status')!;
const message = document.querySelector<HTMLParagraphElement>('#teacher-message')!;
const view = document.querySelector<HTMLDivElement>('#teacher-view')!;

function say(text: string, tone: 'info' | 'error' | 'ok' = 'info') {
  message.textContent = text;
  message.dataset.tone = tone;
}

async function call(path: string, body?: Record<string, unknown>): Promise<TeacherState> {
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : '本機服務沒有回應。');
  return data as TeacherState;
}

function field(id: string, label: string, type: string, autocomplete: string, hint = '') {
  return `
    <label class="teacher-field" for="${id}">
      <span>${label}</span>
      <input id="${id}" type="${type}" autocomplete="${autocomplete}" spellcheck="false" />
      ${hint ? `<small>${hint}</small>` : ''}
    </label>`;
}

function value(id: string) {
  return document.querySelector<HTMLInputElement>(`#${id}`)!.value;
}

function checkPasswords(password: string, confirm: string, required: boolean) {
  if (!password && !required) return true;
  if (password.length < PASSWORD_MIN) {
    say(`教師密碼至少需要 ${PASSWORD_MIN} 個字元。`, 'error');
    return false;
  }
  if (password !== confirm) {
    say('兩次輸入的密碼不一樣。', 'error');
    return false;
  }
  return true;
}

function bindSubmit(form: HTMLFormElement, handler: () => Promise<void>) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    void handler()
      .catch((error: Error) => say(error.message, 'error'))
      .finally(() => { button.disabled = false; });
  });
}

function renderStatus(state: TeacherState) {
  const chips: [string, boolean][] = [
    [state.initialized ? '教師密碼：已設定' : '教師密碼：未設定', state.initialized],
    [state.aiConfigured ? 'NMKING 金鑰：已設定' : 'NMKING 金鑰：未設定', state.aiConfigured],
    [state.loggedIn ? '已登入' : '未登入', state.loggedIn],
  ];
  statusBox.replaceChildren(...chips.map(([text, ok]) => {
    const chip = document.createElement('span');
    chip.className = ok ? 'teacher-chip ok' : 'teacher-chip';
    chip.textContent = text;
    return chip;
  }));
}

function render(state: TeacherState) {
  renderStatus(state);
  document.body.classList.remove('workspace-mode');
  if (!state.initialized) {
    view.innerHTML = `
      <form id="setup-form" class="teacher-form">
        <h2>第一次設定</h2>
        ${field('setup-password', '教師密碼', 'password', 'new-password', `至少 ${PASSWORD_MIN} 個字元，之後登入這一頁使用。`)}
        ${field('setup-confirm', '再輸入一次教師密碼', 'password', 'new-password')}
        ${field('setup-key', 'NMKING AI 金鑰（可先留白）', 'password', 'off', '留白時學生只能使用「本機提示」。')}
        <button type="submit" class="teacher-primary">保存到這台電腦</button>
      </form>`;
    const form = document.querySelector<HTMLFormElement>('#setup-form')!;
    bindSubmit(form, async () => {
      const password = value('setup-password');
      if (!checkPasswords(password, value('setup-confirm'), true)) return;
      const next = await call('/api/teacher/setup', { password, aiKey: value('setup-key') });
      say('已保存。欄位清空是正常的，金鑰不會再顯示。', 'ok');
      render(next);
    });
    return;
  }

  if (!state.loggedIn) {
    view.innerHTML = `
      <form id="login-form" class="teacher-form">
        <h2>教師登入</h2>
        ${field('login-password', '教師密碼', 'password', 'current-password')}
        <button type="submit" class="teacher-primary">登入</button>
      </form>`;
    const form = document.querySelector<HTMLFormElement>('#login-form')!;
    bindSubmit(form, async () => {
      const next = await call('/api/teacher/login', { password: value('login-password') });
      say('已登入。用完請按「登出」。', 'ok');
      render(next);
    });
    document.querySelector<HTMLInputElement>('#login-password')!.focus();
    return;
  }

  document.body.classList.add('workspace-mode');
  renderWorkspace(view, { aiConfigured: state.aiConfigured, renderSettings: (into) => renderSettings(into, state) });
}

function renderSettings(into: HTMLElement, state: TeacherState) {
  const goalOptions = Object.values(CLASS_GOALS)
    .map((goal) => `<option value="${goal.id}"${goal.id === state.goal ? ' selected' : ''}>${goal.label}——${goal.hint}</option>`)
    .join('');
  into.innerHTML = `
    <form id="goal-form" class="teacher-form">
      <h2>本課目標</h2>
      <label class="teacher-field" for="settings-goal">
        <span>學生畫面上方會顯示這個目標，導師也會依它引導</span>
        <select id="settings-goal">${goalOptions}</select>
      </label>
      <div class="teacher-actions"><button type="submit" class="teacher-primary">更新目標</button></div>
    </form>
    <form id="settings-form" class="teacher-form">
      <h2>金鑰與密碼</h2>
      ${field('settings-key', state.aiConfigured ? '更換 NMKING AI 金鑰（留白＝保留目前金鑰）' : 'NMKING AI 金鑰', 'password', 'off')}
      <label class="teacher-check"><input id="settings-clear" type="checkbox" ${state.aiConfigured ? '' : 'disabled'} /> 清除已保存的金鑰（學生將只能用「本機提示」）</label>
      ${field('settings-password', '新的教師密碼（留白＝不變）', 'password', 'new-password')}
      ${field('settings-confirm', '再輸入一次新密碼', 'password', 'new-password')}
      <div class="teacher-actions">
        <button type="submit" class="teacher-primary">保存</button>
        <button type="button" id="logout" class="teacher-secondary">登出</button>
      </div>
    </form>`;
  bindSubmit(into.querySelector<HTMLFormElement>('#goal-form')!, async () => {
    const goal = into.querySelector<HTMLSelectElement>('#settings-goal')!.value;
    const next = await call('/api/teacher/settings', { goal });
    say(`本課目標已改為「${CLASS_GOALS[next.goal as keyof typeof CLASS_GOALS]?.label ?? ''}」；學生重新開啟導師視窗或重新整理後就會看到。`, 'ok');
    state.goal = next.goal;
  });
  bindSubmit(into.querySelector<HTMLFormElement>('#settings-form')!, async () => {
    const password = value('settings-password');
    if (!checkPasswords(password, value('settings-confirm'), false)) return;
    const aiKey = value('settings-key');
    const clearAi = document.querySelector<HTMLInputElement>('#settings-clear')!.checked;
    if (clearAi && aiKey) {
      say('「清除金鑰」與「更換金鑰」只能擇一。', 'error');
      return;
    }
    const next = await call('/api/teacher/settings', { aiKey, clearAi, password });
    say(clearAi ? '已清除金鑰。' : '已保存。留白的欄位維持原設定。', 'ok');
    render(next);
  });
  into.querySelector<HTMLButtonElement>('#logout')!.addEventListener('click', () => {
    void call('/api/teacher/logout', {})
      .then((next) => { say('已登出，畫面上的紀錄已清除。', 'info'); render(next); })
      .catch((error: Error) => say(error.message, 'error'));
  });
}

async function start() {
  if (!/^https?:$/.test(location.protocol)) {
    statusBox.textContent = '請從本機導師服務開啟這一頁。';
    return;
  }
  try {
    render(await call('/api/teacher/session'));
  } catch {
    statusBox.textContent = '連不到本機導師服務。請在專案資料夾執行 npm run tutor:build 與 npm run tutor:serve，再開 http://127.0.0.1:8620/teacher.html 。線上 GitHub Pages 版沒有教師設定。';
  }
}

void start();
