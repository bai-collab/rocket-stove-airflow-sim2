import { CLASS_GOALS } from '../tutor/goals.mjs';
import { GRID_COLS, GRID_ROWS, TUTOR_METRICS } from '../tutor/stove-context.mjs';
import { getWallMaterial } from '../physics/wall-materials.mjs';

type Cell = { c: number; r: number };
type Design = { preset: string; edited: boolean; walls: (Cell & { material: string })[]; fuels: Cell[] };
type TestSummary = {
  durationSec: number; finalPhase: string; burnFraction: number; peakFuelTemperature: number;
  averageFuelOxygen: number; peakSmoke: number; smokeOut: number; secondaryObserved: boolean;
  charRetention: number; carbonizationIndex: number; pyrolysisFraction: number;
};
type LearningRecord = {
  id: string; seq: number; type: 'test' | 'tutor'; studentId: string; timestamp: string; goal: string; design: Design;
  endReason?: string; summary?: TestSummary;
  mode?: 'mock' | 'model'; status?: 'completed' | 'failed'; question?: string; guidance?: string; followup?: string;
  errorCode?: string; relatedMetrics?: string[];
};
type RecordsResponse = { records: LearningRecord[]; total: number; truncated: boolean };
type AnalysisItem = { text: string; recordIds: string[] };
type AnalysisResult = { observations: AnalysisItem[]; interpretations: AnalysisItem[]; suggestions: AnalysisItem[]; limitations: string[] };

const ANALYSIS_LIMIT = 100;
const MAP_SCALE = 6;
const END_REASONS: Record<string, string> = {
  reset: '重新載入爐型', edit: '修改爐型', clear: '全部清除', leave: '離開頁面', checkpoint: '測試滿 2 分鐘',
};
const PRESET_LABELS: Record<string, string> = {
  straight: 'A 垂直升火筒', baffle: 'B Z 型折流爐', twinChannel: 'C 雙通道預熱爐', closed: 'D 完全封閉', custom: '自訂',
};
const QUICK_QUESTIONS = ['整理這批測試的主要發現', '學生的提問透露了哪些迷思？', '下一堂課我可以怎麼引導？'];
const dateKey = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeLabel = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

/** Small DOM helper: every piece of record text goes through textContent. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, options: { className?: string; text?: string; attrs?: Record<string, string> } = {}, children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

const goalLabel = (id: string) => CLASS_GOALS[id as keyof typeof CLASS_GOALS]?.label ?? '自由探索';
const percent = (value: number) => `${(value * 100).toFixed(0)}%`;

function designCanvas(design: Design) {
  const canvas = el('canvas', { className: 'design-map', attrs: {
    width: String(GRID_COLS * MAP_SCALE), height: String(GRID_ROWS * MAP_SCALE), role: 'img',
    'aria-label': `爐型：${design.walls.length} 格磚、${design.fuels.length} 格稻稈`,
  } });
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const wall of design.walls) {
    ctx.fillStyle = getWallMaterial(wall.material).color;
    ctx.fillRect(wall.c * MAP_SCALE, wall.r * MAP_SCALE, MAP_SCALE, MAP_SCALE);
  }
  ctx.fillStyle = '#e8be42';
  for (const fuel of design.fuels) ctx.fillRect(fuel.c * MAP_SCALE, fuel.r * MAP_SCALE, MAP_SCALE, MAP_SCALE);
  return canvas;
}

function testHeadline(summary: TestSummary) {
  return `黑煙排出 ${summary.smokeOut.toFixed(3)} · 炭保留 ${percent(summary.charRetention)} · 持續燃燒 ${percent(summary.burnFraction)}${summary.finalPhase === 'extinguished' ? ' · 熄火' : ''}`;
}

function recordDetails(record: LearningRecord) {
  const body = el('div', { className: 'record-body' });
  const facts = el('dl', { className: 'record-facts' });
  const fact = (label: string, value: string) => facts.append(el('dt', { text: label }), el('dd', { text: value }));
  fact('爐型', `${PRESET_LABELS[record.design.preset] ?? '自訂'}${record.design.edited ? '（有修改）' : ''}`);
  fact('本課目標', goalLabel(record.goal));
  if (record.type === 'test' && record.summary) {
    const s = record.summary;
    fact('測試長度', `${s.durationSec.toFixed(0)} 秒（${END_REASONS[record.endReason ?? ''] ?? '結束'}）`);
    fact('最後狀態', s.finalPhase === 'burning' ? '燃燒中' : s.finalPhase === 'extinguished' ? '熄滅' : '未點火');
    fact('持續燃燒比例', percent(s.burnFraction));
    fact('燃料區最高溫', `${s.peakFuelTemperature.toFixed(0)} °C`);
    fact('燃料區平均氧氣', percent(s.averageFuelOxygen));
    fact('黑煙排出累積', s.smokeOut.toFixed(3));
    fact('最高相對黑煙', s.peakSmoke.toFixed(3));
    fact('出現二次燃燒', s.secondaryObserved ? '是' : '否');
    fact('炭保留率', percent(s.charRetention));
    fact('熱裂解比例', percent(s.pyrolysisFraction));
  } else {
    fact('模式', record.mode === 'model' ? 'NMKING 真實模型' : '本機提示');
    fact('學生提問', record.question ?? '');
    if (record.status === 'failed') fact('結果', `失敗（${record.errorCode ?? ''}）`);
    else {
      fact('這一輪先做', record.guidance ?? '');
      fact('接著想一想', record.followup ?? '');
      if (record.relatedMetrics?.length) {
        fact('指出的指標', record.relatedMetrics.map((key) => TUTOR_METRICS[key as keyof typeof TUTOR_METRICS] ?? key).join('、'));
      }
    }
  }
  body.append(designCanvas(record.design), facts);
  return body;
}

export function renderWorkspace(container: HTMLElement, options: { aiConfigured: boolean; renderSettings: (into: HTMLElement) => void }) {
  container.replaceChildren();
  const tabs = el('div', { className: 'workspace-tabs', attrs: { role: 'tablist' } });
  const panels = el('div', { className: 'workspace-panels' });
  const tabNames = [['records', '學生紀錄'], ['analysis', 'AI 分析'], ['settings', '設定']] as const;
  const tabButtons = new Map<string, HTMLButtonElement>();
  const tabPanels = new Map<string, HTMLElement>();
  for (const [id, label] of tabNames) {
    const button = el('button', { className: 'workspace-tab', text: label, attrs: { type: 'button', role: 'tab', id: `tab-${id}` } });
    const panel = el('section', { className: 'workspace-panel', attrs: { role: 'tabpanel', 'aria-labelledby': `tab-${id}` } });
    button.addEventListener('click', () => selectTab(id));
    tabButtons.set(id, button);
    tabPanels.set(id, panel);
    tabs.append(button);
    panels.append(panel);
  }
  container.append(tabs, panels);

  function selectTab(id: string) {
    for (const [key, button] of tabButtons) {
      const active = key === id;
      button.setAttribute('aria-selected', String(active));
      tabPanels.get(key)!.hidden = !active;
    }
  }

  // ---- Records tab ----
  let records: LearningRecord[] = [];
  let student: string | null = null;
  let truncatedNote = '';
  const recordsPanel = tabPanels.get('records')!;
  const search = el('input', { attrs: { type: 'search', placeholder: '搜尋學生代號', 'aria-label': '搜尋學生代號' } });
  const studentList = el('ul', { className: 'student-list' });
  const typeFilter = el('select', { attrs: { 'aria-label': '紀錄類型' } }, [
    el('option', { text: '全部紀錄', attrs: { value: '' } }),
    el('option', { text: '測試', attrs: { value: 'test' } }),
    el('option', { text: '導師提問', attrs: { value: 'tutor' } }),
  ]);
  const goalFilter = el('select', { attrs: { 'aria-label': '本課目標' } }, [
    el('option', { text: '全部目標', attrs: { value: '' } }),
    ...Object.values(CLASS_GOALS).map((goal) => el('option', { text: goal.label, attrs: { value: goal.id } })),
  ]);
  const dateFilter = el('input', { attrs: { type: 'date', 'aria-label': '日期（臺北時間）' } });
  const refresh = el('button', { className: 'teacher-secondary', text: '重新整理', attrs: { type: 'button' } });
  const scopeNote = el('p', { className: 'scope-note' });
  const timeline = el('ol', { className: 'record-timeline' });
  recordsPanel.append(el('div', { className: 'records-layout' }, [
    el('aside', { className: 'student-aside' }, [search, studentList]),
    el('div', { className: 'records-main' }, [
      el('div', { className: 'record-filters' }, [typeFilter, goalFilter, dateFilter, refresh]),
      scopeNote,
      timeline,
    ]),
  ]));

  function filtered() {
    return records.filter((record) => (!student || record.studentId === student) &&
      (!typeFilter.value || record.type === typeFilter.value) &&
      (!goalFilter.value || record.goal === goalFilter.value) &&
      (!dateFilter.value || dateKey.format(new Date(record.timestamp)) === dateFilter.value));
  }

  function renderStudents() {
    const query = search.value.trim().toLowerCase();
    const counts = new Map<string, { tests: number; asks: number }>();
    for (const record of records) {
      const row = counts.get(record.studentId) ?? { tests: 0, asks: 0 };
      if (record.type === 'test') row.tests += 1;
      else row.asks += 1;
      counts.set(record.studentId, row);
    }
    const entries = [...counts.entries()].filter(([id]) => id.toLowerCase().includes(query))
      .sort(([a], [b]) => a.localeCompare(b, 'zh-Hant'));
    const button = (id: string | null, label: string, detail: string) => {
      const item = el('button', { className: 'student-button', attrs: { type: 'button', 'aria-pressed': String(student === id) } }, [
        el('strong', { text: label }), el('small', { text: detail }),
      ]);
      item.addEventListener('click', () => {
        student = id;
        renderStudents();
        renderTimeline();
      });
      return el('li', {}, [item]);
    };
    studentList.replaceChildren(button(null, '全部學生', `${records.length} 筆紀錄`),
      ...entries.map(([id, row]) => button(id, id, `測試 ${row.tests} · 提問 ${row.asks}`)));
    if (!entries.length) studentList.append(el('li', { className: 'empty-note', text: records.length ? '沒有符合的代號' : '尚無紀錄' }));
  }

  function renderTimeline() {
    const list = filtered();
    scopeNote.textContent = `${student ? `學生 ${student}` : '全部學生'}：${list.length} 筆` +
      (list.length > ANALYSIS_LIMIT ? `（AI 分析只取最新 ${ANALYSIS_LIMIT} 筆）` : '') + truncatedNote;
    timeline.replaceChildren(...list.map((record) => {
      const details = el('details', { className: `record-item ${record.type}`, attrs: { 'data-record-id': record.id } });
      const headline = record.type === 'test' && record.summary ? testHeadline(record.summary)
        : `${record.mode === 'model' ? '真實模型' : '本機提示'}${record.status === 'failed' ? '（失敗）' : ''}：${record.question ?? ''}`;
      details.append(el('summary', {}, [
        el('span', { className: 'record-time', text: timeLabel.format(new Date(record.timestamp)) }),
        el('span', { className: 'record-student', text: record.studentId }),
        el('span', { className: `record-badge ${record.type}`, text: record.type === 'test' ? '測試' : '提問' }),
        el('span', { className: 'record-headline', text: headline }),
      ]));
      details.addEventListener('toggle', () => {
        if (details.open && !details.querySelector('.record-body')) details.append(recordDetails(record));
      }, { once: false });
      return el('li', {}, [details]);
    }));
    if (!list.length) timeline.append(el('li', { className: 'empty-note', text: '沒有符合篩選的紀錄。學生需在模擬器上方輸入代號，點火測試或向導師提問後才會產生紀錄。' }));
    renderAnalysisScope();
  }

  async function loadRecords() {
    refresh.disabled = true;
    try {
      const response = await fetch('/api/teacher/records', { cache: 'no-store' });
      const data = await response.json().catch(() => null) as RecordsResponse | null;
      if (!response.ok || !data) throw new Error((data as { error?: string } | null)?.error ?? '讀取紀錄失敗。');
      records = data.records;
      truncatedNote = data.truncated ? `；伺服器只送出最新 ${records.length} 筆（共 ${data.total} 筆）` : '';
      renderStudents();
      renderTimeline();
    } catch (error) {
      timeline.replaceChildren(el('li', { className: 'empty-note', text: (error as Error).message }));
    } finally {
      refresh.disabled = false;
    }
  }

  search.addEventListener('input', renderStudents);
  for (const control of [typeFilter, goalFilter, dateFilter]) control.addEventListener('change', renderTimeline);
  refresh.addEventListener('click', () => void loadRecords());

  function showRecord(id: string) {
    selectTab('records');
    if (!filtered().some((record) => record.id === id)) {
      student = null;
      typeFilter.value = '';
      goalFilter.value = '';
      dateFilter.value = '';
      renderStudents();
      renderTimeline();
    }
    const item = timeline.querySelector<HTMLDetailsElement>(`[data-record-id="${CSS.escape(id)}"]`);
    if (!item) return;
    item.open = true;
    item.scrollIntoView({ block: 'center' });
    item.querySelector('summary')?.focus();
  }

  // ---- Analysis tab ----
  const analysisPanel = tabPanels.get('analysis')!;
  const analysisScope = el('p', { className: 'scope-note' });
  const modeLocal = el('input', { attrs: { type: 'radio', name: 'analysis-mode', value: 'local', checked: '' } });
  const modeModel = el('input', { attrs: { type: 'radio', name: 'analysis-mode', value: 'model' } });
  modeModel.disabled = !options.aiConfigured;
  const question = el('textarea', { attrs: { rows: '3', maxlength: '300', placeholder: '想問這批紀錄的問題', 'aria-label': '分析問題' } });
  const quick = el('div', { className: 'quick-questions' }, QUICK_QUESTIONS.map((text) => {
    const button = el('button', { className: 'teacher-secondary', text, attrs: { type: 'button' } });
    button.addEventListener('click', () => { question.value = text; question.focus(); });
    return button;
  }));
  const run = el('button', { className: 'teacher-primary', text: '開始分析', attrs: { type: 'button' } });
  const cancel = el('button', { className: 'teacher-secondary', text: '取消', attrs: { type: 'button' } });
  cancel.hidden = true;
  const analysisNote = el('p', { className: 'analysis-note' });
  const output = el('div', { className: 'analysis-output', attrs: { 'aria-live': 'polite' } });
  analysisPanel.append(
    analysisScope,
    el('fieldset', { className: 'analysis-modes' }, [
      el('legend', { text: '分析方式' }),
      el('label', {}, [modeLocal, ' 本機摘要（不呼叫 AI）']),
      el('label', {}, [modeModel, ` NMKING 真實模型${options.aiConfigured ? '' : '（尚未設定金鑰）'}`]),
    ]),
    quick, question, el('div', { className: 'teacher-actions' }, [run, cancel]), analysisNote, output,
  );

  function selection() {
    return filtered().slice(0, ANALYSIS_LIMIT);
  }

  function renderAnalysisScope() {
    const chosen = selection();
    analysisScope.textContent = chosen.length
      ? `分析範圍＝「學生紀錄」目前的篩選：${student ? `學生 ${student}` : '全部學生'}，${chosen.length} 筆` +
        `（${timeLabel.format(new Date(chosen.at(-1)!.timestamp))} ～ ${timeLabel.format(new Date(chosen[0].timestamp))}）。`
      : '目前篩選沒有紀錄可分析。';
    run.disabled = !chosen.length;
  }

  function updateAnalysisNote() {
    analysisNote.textContent = modeModel.checked
      ? '會把所選紀錄（代號、爐型、測試摘要、學生提問與導師回覆）送到 NMKING；按一次呼叫一次 AI，可能消耗額度。結果是推測，請對照原紀錄。'
      : '本機摘要只做統計，不呼叫 AI。';
  }
  modeLocal.addEventListener('change', updateAnalysisNote);
  modeModel.addEventListener('change', updateAnalysisNote);
  updateAnalysisNote();

  function renderResult(result: AnalysisResult, source: string) {
    const section = (title: string, items: AnalysisItem[], className: string) => {
      if (!items.length) return null;
      return el('section', { className: `analysis-section ${className}` }, [
        el('h3', { text: title }),
        el('ul', {}, items.map((item) => el('li', {}, [
          el('span', { text: item.text }),
          ...item.recordIds.map((id) => {
            const record = records.find((candidate) => candidate.id === id);
            const label = record
              ? `${record.studentId} ${timeLabel.format(new Date(record.timestamp))}${record.type === 'test' ? ' 測試' : ' 提問'}`
              : '紀錄';
            const chip = el('button', { className: 'citation', text: label, attrs: { type: 'button', title: '跳到這筆紀錄' } });
            chip.addEventListener('click', () => showRecord(id));
            return chip;
          }),
        ]))),
      ]);
    };
    output.replaceChildren(...[
      el('p', { className: 'analysis-source', text: source === 'model' ? 'NMKING 真實模型分析' : '本機摘要' }),
      section('直接觀察', result.observations, 'observations'),
      section('推測（待教師確認）', result.interpretations, 'interpretations'),
      section('教學建議', result.suggestions, 'suggestions'),
      el('section', { className: 'analysis-section limitations' }, [
        el('h3', { text: '資料限制' }), el('ul', {}, result.limitations.map((text) => el('li', { text }))),
      ]),
    ].filter((node): node is HTMLElement => node !== null));
  }

  let pending: AbortController | null = null;
  run.addEventListener('click', async () => {
    const chosen = selection();
    const mode = modeModel.checked ? 'model' : 'local';
    if (mode === 'model' && !question.value.trim()) {
      analysisNote.textContent = '請先輸入或選一個分析問題。';
      question.focus();
      return;
    }
    pending = new AbortController();
    run.disabled = true;
    cancel.hidden = mode !== 'model';
    output.replaceChildren(el('p', { className: 'analysis-source', text: mode === 'model' ? 'AI 分析中，可能需要一兩分鐘…' : '整理中…' }));
    try {
      const response = await fetch('/api/teacher/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, recordIds: chosen.map((record) => record.id), question: question.value.trim() }),
        signal: pending.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.result) throw new Error(typeof data?.error === 'string' ? data.error : '分析失敗。');
      renderResult(data.result as AnalysisResult, data.source);
    } catch (error) {
      output.replaceChildren(el('p', { className: 'analysis-error', text: pending?.signal.aborted
        ? '已取消；AI 服務端可能仍會計算這次額度。' : (error as Error).message }));
    } finally {
      pending = null;
      run.disabled = false;
      cancel.hidden = true;
      renderAnalysisScope();
    }
  });
  cancel.addEventListener('click', () => pending?.abort());

  // ---- Settings tab ----
  options.renderSettings(tabPanels.get('settings')!);

  selectTab('records');
  void loadRecords();
}
