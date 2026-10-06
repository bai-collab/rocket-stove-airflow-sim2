// Minimal Apps Script runtime for tests: runs scripts/tutor/sheets/Code.gs in a
// vm with one in-memory spreadsheet and emulates the /exec 302 redirect.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

export const SHEET_URL = 'https://script.google.com/macros/s/AKfycbTestDeployment123/exec';
export const TOKEN = 'class-token-0123456789';
const codeGs = await fs.readFile(new URL('../../scripts/tutor/sheets/Code.gs', import.meta.url), 'utf8');

/** Minimal Apps Script runtime: one spreadsheet held in memory as a 2D array. */
export function fakeAppsScript(token = TOKEN) {
  const sheets = new Map();
  const properties = new Map([['RECORD_TOKEN', token]]);
  const chain = { setBackground: () => chain, setFontColor: () => chain, setFontWeight: () => chain };
  function makeSheet() {
    const rows = [];
    const sheet = {
      rows,
      getLastRow: () => rows.length,
      getRange: (row, col, numRows = 1, numCols = 1) => ({
        ...chain,
        getValue: () => rows[row - 1]?.[col - 1] ?? '',
        getValues: () => Array.from({ length: numRows }, (_, r) =>
          Array.from({ length: numCols }, (_, c) => rows[row - 1 + r]?.[col - 1 + c] ?? '')),
        setValues: (values) => {
          values.forEach((line, r) => line.forEach((value, c) => {
            if (typeof value === 'string' && value.length > 50000) throw new Error('cell too large');
            rows[row - 1 + r] ??= [];
            rows[row - 1 + r][col - 1 + c] = value;
          }));
          return chain;
        },
      }),
      setFrozenRows() {}, setColumnWidths() {}, hideColumns() {},
    };
    return sheet;
  }
  const book = {
    getId: () => 'sheet-1',
    getSheetByName: (name) => sheets.get(name) ?? null,
    insertSheet: (name) => { const sheet = makeSheet(); sheets.set(name, sheet); return sheet; },
  };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => properties.get(k) ?? null, setProperty: (k, v) => properties.set(k, v) }) },
    SpreadsheetApp: { openById: () => book, getActiveSpreadsheet: () => book, flush() {} },
    ContentService: { createTextOutput: (text) => ({ text, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    LockService: { getScriptLock: () => ({ waitLock() {}, hasLock: () => true, releaseLock() {} }) },
    Utilities: { formatDate: (date) => date.toISOString() },
    Logger: { log() {} },
  });
  vm.runInContext(codeGs, context);
  context.setupSheet();
  const pending = new Map();
  let echo = 0;
  const fetchImpl = async (url, init) => {
    if (url === SHEET_URL && init.method === 'POST') {
      assert.equal(init.redirect, 'manual');
      const output = context.doPost({ postData: { contents: init.body } });
      const id = `e${++echo}`;
      pending.set(id, output.text);
      return new Response(null, { status: 302, headers: { Location: `https://script.googleusercontent.com/macros/echo?id=${id}` } });
    }
    const id = new URL(url).searchParams.get('id');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    return new Response(pending.get(id), { status: 200 });
  };
  return { fetchImpl, sheet: () => sheets.get('火箭爐學習紀錄'), properties };
}

