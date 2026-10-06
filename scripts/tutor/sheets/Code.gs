/**
 * 火箭爐設計導師：學習紀錄同步（Google Apps Script，綁定在教師自己的試算表）
 *
 * 設定步驟見 docs/GOOGLE_SHEET_SYNC.md。
 * 1. 指令碼屬性（專案設定 → 指令碼屬性）新增 RECORD_TOKEN，值與教師頁設定相同（16～200 個英數符號）。
 * 2. 在編輯器選 setupSheet 執行一次並授權。
 * 3. 部署 → 新增部署作業 → 網頁應用程式；執行身分「我」、存取權「所有人」；複製結尾是 /exec 的網址。
 *
 * 任何人只要同時知道 /exec 網址與 RECORD_TOKEN，就能讀寫這張表的紀錄；兩者都不要公開。
 */

var SHEET_NAME = '火箭爐學習紀錄';
var HEADERS = ['紀錄ID', '時間（臺北）', '學生代號', '類型', '本課目標', '爐型', '模式／結束原因', '狀態',
  '黑煙排出累積', '炭保留率', '持續燃燒比例', '最後狀態', '學生提問', '導師回覆', '追問', '來源電腦',
  '完整紀錄1', '完整紀錄2', '完整紀錄3', '完整紀錄4'];
var JSON_COLUMN = 17;
var JSON_PARTS = 4;
var CHUNK = 40000;
var MAX_BATCH = 50;
var MAX_READ = 100;
var TEXT_MARK = '​';

var GOALS = { free: '自由探索', lowSmoke: '低黑煙', keepChar: '多留炭', stableBurn: '穩定燃燒' };
var PRESETS = { straight: 'A 垂直升火筒', baffle: 'B Z 型折流爐', twinChannel: 'C 雙通道預熱爐', closed: 'D 完全封閉', custom: '自訂' };
var END_REASONS = { reset: '重新載入爐型', edit: '修改爐型', clear: '全部清除', leave: '離開頁面', checkpoint: '滿 2 分鐘' };
var PHASES = { unlit: '未點火', burning: '燃燒中', extinguished: '熄滅' };

function setupSheet() {
  var properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty('SHEET_ID')) {
    properties.setProperty('SHEET_ID', SpreadsheetApp.getActiveSpreadsheet().getId());
  }
  sheet_();
  var token = properties.getProperty('RECORD_TOKEN') || '';
  Logger.log(token.length >= 16 ? '設定完成，可以部署為網頁應用程式。' : '請到「專案設定 → 指令碼屬性」新增 RECORD_TOKEN（16～200 字）。');
}

function sheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('NOT_CONFIGURED');
  var book = SpreadsheetApp.openById(id);
  var sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setBackground('#9f1239').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, HEADERS.length, 130);
    sheet.setColumnWidths(13, 3, 280);
    sheet.hideColumns(JSON_COLUMN, JSON_PARTS);
  }
  if (sheet.getRange(1, 1).getValue() !== HEADERS[0]) throw new Error('WRONG_SHEET');
  return sheet;
}

function output_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

// 文字一律加零寬前綴，避免 =、+、-、@ 開頭被試算表當成公式；讀回時移除。
function cell_(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  return TEXT_MARK + String(value === null || value === undefined ? '' : value);
}

function uncell_(value) {
  return typeof value === 'string' && value.charAt(0) === TEXT_MARK ? value.slice(1) : String(value);
}

function chunks_(text) {
  var parts = [];
  for (var start = 0; start < text.length;) {
    var end = Math.min(start + CHUNK, text.length);
    // 不要把一個 UTF-16 代理對切成兩半。
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(end))) end -= 1;
    parts.push(text.slice(start, end));
    start = end;
  }
  if (parts.length > JSON_PARTS) throw new Error('TOO_LARGE');
  while (parts.length < JSON_PARTS) parts.push('');
  return parts;
}

function validRecord_(record) {
  return record && typeof record === 'object' &&
    /^[a-zA-Z0-9_-]{8,80}$/.test(record.id || '') &&
    /^[\p{L}\p{N}_-]{1,20}$/u.test(record.studentId || '') &&
    (record.type === 'test' || record.type === 'tutor') &&
    !isNaN(Date.parse(record.timestamp));
}

function row_(record) {
  var summary = record.summary || {};
  var isTest = record.type === 'test';
  var design = record.design || {};
  var row = [
    record.id,
    Utilities.formatDate(new Date(record.timestamp), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss'),
    record.studentId,
    isTest ? '測試' : '導師提問',
    GOALS[record.goal] || '自由探索',
    (PRESETS[design.preset] || '自訂') + (design.edited ? '（有修改）' : ''),
    isTest ? (END_REASONS[record.endReason] || '') : (record.mode === 'model' ? 'NMKING 真實模型' : '本機提示'),
    isTest ? '' : (record.status === 'failed' ? '失敗' : '完成'),
    isTest ? Number(summary.smokeOut) : '',
    isTest ? Number(summary.charRetention) : '',
    isTest ? Number(summary.burnFraction) : '',
    isTest ? (PHASES[summary.finalPhase] || '') : '',
    isTest ? '' : (record.question || ''),
    isTest ? '' : (record.guidance || record.errorCode || ''),
    isTest ? '' : (record.followup || ''),
    record.computer || ''
  ];
  return row.concat(chunks_(JSON.stringify(record))).map(cell_);
}

function append_(sheet, records) {
  if (!Array.isArray(records) || records.length < 1 || records.length > MAX_BATCH) throw new Error('INVALID_BATCH');
  var last = sheet.getLastRow();
  var existing = {};
  if (last > 1) {
    sheet.getRange(2, 1, last - 1, 1).getValues().forEach(function (row) { existing[uncell_(row[0])] = true; });
  }
  var rows = [];
  var ids = [];
  records.forEach(function (record) {
    if (!validRecord_(record)) throw new Error('INVALID_RECORD');
    ids.push(record.id);
    if (existing[record.id]) return; // 重送的紀錄只回報收到，不重複寫入。
    existing[record.id] = true;
    rows.push(row_(record));
  });
  if (rows.length) {
    sheet.getRange(last + 1, 1, rows.length, HEADERS.length).setValues(rows);
    SpreadsheetApp.flush();
  }
  return { ok: true, ids: ids, written: rows.length };
}

function read_(sheet, offset, limit) {
  if (typeof offset !== 'number' || offset < 0 || Math.floor(offset) !== offset) throw new Error('INVALID_OFFSET');
  var size = Math.min(MAX_READ, Math.max(1, Math.floor(limit || MAX_READ)));
  var available = Math.max(0, sheet.getLastRow() - 1);
  var count = Math.max(0, Math.min(size, available - offset));
  var records = [];
  if (count) {
    sheet.getRange(offset + 2, JSON_COLUMN, count, JSON_PARTS).getValues().forEach(function (row) {
      try {
        records.push(JSON.parse(row.map(uncell_).join('')));
      } catch (error) {
        records.push(null); // 被手動改壞的列：本機服務會略過。
      }
    });
  }
  return { ok: true, records: records, nextOffset: offset + count, more: offset + count < available };
}

function doPost(e) {
  var lock = null;
  try {
    if (!e || !e.postData || e.postData.contents.length > 3000000) return output_({ ok: false, code: 'INVALID_REQUEST' });
    var body = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty('RECORD_TOKEN') || '';
    if (token.length < 16 || body.token !== token) return output_({ ok: false, code: 'AUTH_REJECTED' });
    lock = LockService.getScriptLock();
    lock.waitLock(10000);
    var sheet = sheet_();
    if (body.action === 'append') return output_(append_(sheet, body.records));
    if (body.action === 'read') return output_(read_(sheet, body.offset, body.limit));
    return output_({ ok: false, code: 'INVALID_ACTION' });
  } catch (error) {
    return output_({ ok: false, code: 'RECORD_SERVICE_FAILED' });
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

function doGet() {
  return output_({ ok: false, code: 'POST_REQUIRED' });
}
