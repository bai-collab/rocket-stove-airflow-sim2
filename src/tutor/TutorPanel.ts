export type TutorCell = { c: number; r: number };
export type TutorHighlight = { cells: TutorCell[]; metrics: string[] };

type TutorReply = {
  guidance: string;
  question: string;
  relatedCells: TutorCell[];
  relatedMetrics: string[];
};

export type ClassGoal = { id: string; label: string; hint: string };
export type TutorServiceStatus = { available: boolean; goal: ClassGoal | null };

type TutorPanelOptions = {
  openButton: HTMLButtonElement;
  getContext: () => unknown;
  /** Valid student id, or null after asking the student to enter one. */
  requireStudentId: () => string | null;
  onHighlight: (highlight: TutorHighlight | null) => void;
  onServiceStatus: (status: TutorServiceStatus) => void;
};

type Availability = 'checking' | 'available' | 'unavailable';
type TutorMode = 'mock' | 'model';
type HistoryTurn = { role: 'student' | 'tutor'; text: string };

const REQUEST_TIMEOUT_MS: Record<TutorMode, number> = { mock: 15000, model: 100000 };
const MAX_HISTORY = 6;
const MODE_STORAGE_KEY = 'rocket-stove-tutor-mode';
const MODE_LABELS: Record<TutorMode, string> = {
  mock: '本機提示 · 不呼叫 AI',
  model: 'NMKING 真實模型 · 可能消耗額度',
};
const UNAVAILABLE_NOTE = '設計導師需要本機服務版：在專案資料夾執行 npm run tutor:build 與 npm run tutor:serve，再開 http://127.0.0.1:8620/ 。線上 GitHub Pages 版沒有導師。';

/**
 * Floating design tutor. It only reads the simulator state and points at
 * cells/metrics; it never places bricks or presses buttons for the student.
 * All tutor and student text is rendered with textContent.
 */
export function createTutorPanel({
  openButton, getContext, requireStudentId, onHighlight, onServiceStatus,
}: TutorPanelOptions) {
  const panel = document.createElement('section');
  panel.className = 'tutor-window';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'tutor-title');
  panel.innerHTML = `
    <header class="tutor-header">
      <div>
        <strong id="tutor-title">爐體設計導師</strong>
        <small class="tutor-mode"></small>
      </div>
      <div class="tutor-header-actions">
        <button type="button" class="tutor-icon" data-action="minimize" aria-label="縮小導師視窗" title="縮小">─</button>
        <button type="button" class="tutor-icon" data-action="close" aria-label="關閉導師視窗" title="關閉">×</button>
      </div>
    </header>
    <div class="tutor-body">
      <ol class="tutor-log" aria-live="polite"></ol>
      <form class="tutor-form">
        <fieldset class="tutor-modes">
          <legend>導師模式</legend>
          <label><input type="radio" name="tutor-mode" value="mock" checked /> 本機提示</label>
          <label><input type="radio" name="tutor-mode" value="model" /> NMKING 真實模型</label>
        </fieldset>
        <label class="tutor-label" for="tutor-question">說說你的想法或卡住的地方</label>
        <textarea id="tutor-question" rows="3" maxlength="300" placeholder="例如：為什麼黑煙一直從上面跑出來？"></textarea>
        <div class="tutor-actions">
          <button type="button" class="tutor-secondary" data-action="highlight" disabled>顯示相關位置</button>
          <button type="button" class="tutor-secondary" data-action="cancel" hidden>取消</button>
          <button type="submit" class="tutor-primary">取得提示</button>
        </div>
        <p class="tutor-note"></p>
        <p class="tutor-teacher-link"><a href="teacher.html" target="_blank" rel="noopener">教師設定</a></p>
      </form>
    </div>
  `;
  document.body.append(panel);

  const header = panel.querySelector<HTMLElement>('.tutor-header')!;
  const log = panel.querySelector<HTMLOListElement>('.tutor-log')!;
  const form = panel.querySelector<HTMLFormElement>('.tutor-form')!;
  const textarea = panel.querySelector<HTMLTextAreaElement>('#tutor-question')!;
  const submitButton = panel.querySelector<HTMLButtonElement>('.tutor-primary')!;
  const highlightButton = panel.querySelector<HTMLButtonElement>('[data-action="highlight"]')!;
  const note = panel.querySelector<HTMLParagraphElement>('.tutor-note')!;
  const modeLabel = panel.querySelector<HTMLElement>('.tutor-mode')!;
  const cancelButton = panel.querySelector<HTMLButtonElement>('[data-action="cancel"]')!;
  const modelRadio = panel.querySelector<HTMLInputElement>('input[name="tutor-mode"][value="model"]')!;
  const mockRadio = panel.querySelector<HTMLInputElement>('input[name="tutor-mode"][value="mock"]')!;

  let availability: Availability = 'checking';
  let pending: AbortController | null = null;
  let lastHighlight: TutorHighlight | null = null;
  let highlightVisible = false;
  let modelAvailable = false;
  let mode: TutorMode = 'mock';
  let history: HistoryTurn[] = [];

  function readStoredMode(): TutorMode {
    try {
      return localStorage.getItem(MODE_STORAGE_KEY) === 'model' ? 'model' : 'mock';
    } catch {
      return 'mock';
    }
  }

  function setMode(next: TutorMode) {
    const effective = next === 'model' && modelAvailable ? 'model' : 'mock';
    if (effective !== mode) history = [];
    mode = effective;
    (mode === 'model' ? modelRadio : mockRadio).checked = true;
    modeLabel.textContent = MODE_LABELS[mode];
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // The choice simply is not remembered.
    }
    refreshControls();
  }

  function setHighlightVisible(visible: boolean) {
    highlightVisible = visible && lastHighlight !== null && !panel.hidden && !panel.classList.contains('minimized');
    onHighlight(highlightVisible ? lastHighlight : null);
    highlightButton.disabled = lastHighlight === null;
    highlightButton.textContent = highlightVisible ? '取消高亮' : '顯示相關位置';
  }

  function refreshControls() {
    const busy = pending !== null;
    submitButton.disabled = availability !== 'available' || busy;
    textarea.disabled = availability === 'unavailable';
    submitButton.textContent = busy ? '思考中…' : mode === 'model' ? '向導師提問' : '取得提示';
    cancelButton.hidden = !busy;
    modelRadio.disabled = availability !== 'available' || !modelAvailable || busy;
    mockRadio.disabled = availability !== 'available' || busy;
    if (availability === 'checking') note.textContent = '正在確認本機導師服務…';
    else if (availability === 'unavailable') note.textContent = UNAVAILABLE_NOTE;
    else if (mode === 'model') note.textContent = '會把目前爐型、觀察數據與你的問題送到 NMKING；每次提問呼叫一次 AI，可能消耗額度，不會自動重試。導師只指出位置，不會替你放磚或點火。';
    else note.textContent = modelAvailable
      ? '提示由本機規則產生，不呼叫 AI。導師只指出位置，不會替你放磚或點火。'
      : '提示由本機規則產生，不呼叫 AI。老師設定 AI 金鑰後才能選「NMKING 真實模型」。';
  }

  function addEntry(role: 'student' | 'tutor' | 'system', lines: [string, string][]) {
    const item = document.createElement('li');
    item.className = `tutor-entry ${role}`;
    for (const [label, text] of lines) {
      const line = document.createElement('p');
      if (label) {
        const strong = document.createElement('strong');
        strong.textContent = label;
        line.append(strong);
      }
      line.append(document.createTextNode(text));
      item.append(line);
    }
    log.append(item);
    log.scrollTop = log.scrollHeight;
  }

  function open() {
    panel.hidden = false;
    panel.classList.remove('minimized');
    openButton.setAttribute('aria-expanded', 'true');
    setHighlightVisible(lastHighlight !== null);
    textarea.focus();
    void detectService();
  }

  function close() {
    panel.hidden = true;
    openButton.setAttribute('aria-expanded', 'false');
    setHighlightVisible(false);
    openButton.focus();
  }

  function toggleMinimized() {
    panel.classList.toggle('minimized');
    const minimized = panel.classList.contains('minimized');
    panel.querySelector('[data-action="minimize"]')!.setAttribute('aria-label', minimized ? '展開導師視窗' : '縮小導師視窗');
    setHighlightVisible(!minimized && lastHighlight !== null);
  }

  async function ask(question: string, studentId: string) {
    pending?.abort();
    const controller = new AbortController();
    const askedMode = mode;
    let timedOut = false;
    pending = controller;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS[askedMode]);
    refreshControls();
    try {
      const response = await fetch('/api/tutor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: askedMode,
          studentId,
          question,
          context: getContext(),
          history: askedMode === 'model' ? history : [],
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.reply) {
        addEntry('system', [['', typeof data?.error === 'string' ? data.error : '導師暫時沒有回應，請稍後再試。']]);
        return;
      }
      const reply = data.reply as TutorReply;
      addEntry('tutor', [['這一輪先做：', reply.guidance], ['接著想一想：', reply.question]]);
      textarea.value = '';
      if (askedMode === 'model' && mode === 'model') {
        history = [...history, { role: 'student' as const, text: question },
          { role: 'tutor' as const, text: `${reply.guidance}\n${reply.question}` }].slice(-MAX_HISTORY);
      }
      lastHighlight = reply.relatedCells.length || reply.relatedMetrics.length
        ? { cells: reply.relatedCells, metrics: reply.relatedMetrics }
        : null;
      setHighlightVisible(true);
    } catch {
      const text = !controller.signal.aborted ? '連不到本機導師服務，請確認服務視窗仍開著。'
        : timedOut ? '等待太久，已停止這次提問；你的文字仍保留在輸入框。'
          : '已取消這次提問；你的文字仍保留在輸入框。AI 服務端可能仍會計算這次額度。';
      addEntry('system', [['', text]]);
    } finally {
      window.clearTimeout(timer);
      if (pending === controller) pending = null;
      refreshControls();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const question = textarea.value.trim();
    if (!question) {
      note.textContent = '請先輸入你的想法或問題。';
      textarea.focus();
      return;
    }
    if (availability !== 'available' || pending) return;
    const studentId = requireStudentId();
    if (!studentId) {
      note.textContent = '請先在畫面上方輸入學生代號，再向導師提問。';
      return;
    }
    addEntry('student', [['', question]]);
    void ask(question, studentId);
  });

  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) form.requestSubmit();
  });

  panel.addEventListener('click', (event) => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]')?.dataset.action;
    if (action === 'close') close();
    else if (action === 'minimize') toggleMinimized();
    else if (action === 'highlight') setHighlightVisible(!highlightVisible);
    else if (action === 'cancel') pending?.abort();
  });

  panel.querySelector('.tutor-modes')!.addEventListener('change', (event) => {
    const value = (event.target as HTMLInputElement).value;
    setMode(value === 'model' ? 'model' : 'mock');
  });

  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  openButton.setAttribute('aria-expanded', 'false');
  openButton.addEventListener('click', () => (panel.hidden ? open() : close()));

  // Drag by the title bar; the window always stays at least partly on screen.
  let drag: { pointerId: number; dx: number; dy: number } | null = null;
  header.addEventListener('pointerdown', (event) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const rect = panel.getBoundingClientRect();
    drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    header.setPointerCapture(event.pointerId);
  });
  header.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const maxX = window.innerWidth - 80;
    const maxY = window.innerHeight - 40;
    panel.style.left = `${Math.max(0, Math.min(maxX, event.clientX - drag.dx))}px`;
    panel.style.top = `${Math.max(0, Math.min(maxY, event.clientY - drag.dy))}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  const endDrag = () => { drag = null; };
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);

  async function detectService() {
    if (!/^https?:$/.test(location.protocol)) {
      availability = 'unavailable';
      onServiceStatus({ available: false, goal: null });
      refreshControls();
      return;
    }
    try {
      const response = await fetch('/api/tutor/status', { cache: 'no-store' });
      const data = response.ok ? await response.json() : null;
      availability = data?.ok === true && data.modes?.mock === true ? 'available' : 'unavailable';
      modelAvailable = availability === 'available' && data.modes.model === true;
      const goal = availability === 'available' && data.goal && typeof data.goal.label === 'string' ? data.goal as ClassGoal : null;
      onServiceStatus({ available: availability === 'available', goal });
    } catch {
      availability = 'unavailable';
      modelAvailable = false;
      onServiceStatus({ available: false, goal: null });
    }
    setMode(readStoredMode());
  }

  modeLabel.textContent = MODE_LABELS[mode];
  refreshControls();
  void detectService();

  return {
    /** Re-read service status, e.g. after a teacher changed the class goal. */
    refreshService: () => detectService(),
    /** The design changed, so earlier cell references may no longer match. */
    designChanged() {
      if (lastHighlight === null) return;
      lastHighlight = null;
      setHighlightVisible(false);
      if (!panel.hidden) addEntry('system', [['', '爐型已改變，先前標出的位置已清除。']]);
    },
  };
}
