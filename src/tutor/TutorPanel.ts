export type TutorCell = { c: number; r: number };
export type TutorHighlight = { cells: TutorCell[]; metrics: string[] };

type TutorReply = {
  guidance: string;
  question: string;
  relatedCells: TutorCell[];
  relatedMetrics: string[];
};

type TutorPanelOptions = {
  openButton: HTMLButtonElement;
  getContext: () => unknown;
  onHighlight: (highlight: TutorHighlight | null) => void;
};

type Availability = 'checking' | 'available' | 'unavailable';

const REQUEST_TIMEOUT_MS = 15000;
const UNAVAILABLE_NOTE = '設計導師需要本機服務版：在專案資料夾執行 npm run tutor:build 與 npm run tutor:serve，再開 http://127.0.0.1:8620/ 。線上 GitHub Pages 版沒有導師。';

/**
 * Floating design tutor. It only reads the simulator state and points at
 * cells/metrics; it never places bricks or presses buttons for the student.
 * All tutor and student text is rendered with textContent.
 */
export function createTutorPanel({ openButton, getContext, onHighlight }: TutorPanelOptions) {
  const panel = document.createElement('section');
  panel.className = 'tutor-window';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'tutor-title');
  panel.innerHTML = `
    <header class="tutor-header">
      <div>
        <strong id="tutor-title">爐體設計導師</strong>
        <small class="tutor-mode">本機提示 · 不呼叫 AI</small>
      </div>
      <div class="tutor-header-actions">
        <button type="button" class="tutor-icon" data-action="minimize" aria-label="縮小導師視窗" title="縮小">─</button>
        <button type="button" class="tutor-icon" data-action="close" aria-label="關閉導師視窗" title="關閉">×</button>
      </div>
    </header>
    <div class="tutor-body">
      <ol class="tutor-log" aria-live="polite"></ol>
      <form class="tutor-form">
        <label class="tutor-label" for="tutor-question">說說你的想法或卡住的地方</label>
        <textarea id="tutor-question" rows="3" maxlength="300" placeholder="例如：為什麼黑煙一直從上面跑出來？"></textarea>
        <div class="tutor-actions">
          <button type="button" class="tutor-secondary" data-action="highlight" disabled>顯示相關位置</button>
          <button type="submit" class="tutor-primary">取得提示</button>
        </div>
        <p class="tutor-note"></p>
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

  let availability: Availability = 'checking';
  let pending: AbortController | null = null;
  let lastHighlight: TutorHighlight | null = null;
  let highlightVisible = false;

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
    submitButton.textContent = busy ? '思考中…' : '取得提示';
    note.textContent = availability === 'available'
      ? '提示由本機規則產生，只會指出位置，不會替你放磚或點火。'
      : availability === 'checking' ? '正在確認本機導師服務…' : UNAVAILABLE_NOTE;
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

  async function ask(question: string) {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    refreshControls();
    try {
      const response = await fetch('/api/tutor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'mock', question, context: getContext() }),
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
      lastHighlight = reply.relatedCells.length || reply.relatedMetrics.length
        ? { cells: reply.relatedCells, metrics: reply.relatedMetrics }
        : null;
      setHighlightVisible(true);
    } catch {
      addEntry('system', [['', controller.signal.aborted ? '等待太久，已停止這次提問；你的文字仍保留在輸入框。' : '連不到本機導師服務，請確認服務視窗仍開著。']]);
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
    addEntry('student', [['', question]]);
    void ask(question);
  });

  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) form.requestSubmit();
  });

  panel.addEventListener('click', (event) => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]')?.dataset.action;
    if (action === 'close') close();
    else if (action === 'minimize') toggleMinimized();
    else if (action === 'highlight') setHighlightVisible(!highlightVisible);
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
      refreshControls();
      return;
    }
    try {
      const response = await fetch('/api/tutor/status', { cache: 'no-store' });
      const data = response.ok ? await response.json() : null;
      availability = data?.ok === true && data.modes?.mock === true ? 'available' : 'unavailable';
    } catch {
      availability = 'unavailable';
    }
    refreshControls();
  }

  refreshControls();
  void detectService();

  return {
    /** The design changed, so earlier cell references may no longer match. */
    designChanged() {
      if (lastHighlight === null) return;
      lastHighlight = null;
      setHighlightVisible(false);
      if (!panel.hidden) addEntry('system', [['', '爐型已改變，先前標出的位置已清除。']]);
    },
  };
}
